from main import app
import main as main_module
from fastapi.testclient import TestClient
import httpx


client = TestClient(app)


def test_get_holidays_returns_seed_file(tmp_path, monkeypatch):
    holiday_file = tmp_path / "holidays.txt"
    holiday_file.write_text("2026-01-01\n2026-01-02\n", encoding="utf-8")
    monkeypatch.setattr(main_module, "HOLIDAYS_FILE_PATH", holiday_file)

    response = client.get("/api/holidays")

    assert response.status_code == 200
    body = response.json()
    assert body["holidays"] == ["2026-01-01", "2026-01-02"]
    assert body["raw_text"] == "2026-01-01\n2026-01-02"
    assert body["file_path"] == str(holiday_file)


def test_add_holiday_appends_unique_date(tmp_path, monkeypatch):
    holiday_file = tmp_path / "holidays.txt"
    holiday_file.write_text("2026-01-01\n", encoding="utf-8")
    monkeypatch.setattr(main_module, "HOLIDAYS_FILE_PATH", holiday_file)

    response = client.post("/api/holidays", json={"date": "2026-01-05"})

    assert response.status_code == 200
    assert response.json()["holidays"] == ["2026-01-01", "2026-01-05"]
    assert holiday_file.read_text(encoding="utf-8") == "2026-01-01\n2026-01-05\n"


def test_update_holidays_raw_rejects_invalid_format(tmp_path, monkeypatch):
    holiday_file = tmp_path / "holidays.txt"
    monkeypatch.setattr(main_module, "HOLIDAYS_FILE_PATH", holiday_file)

    response = client.put("/api/holidays/raw", json={"raw_text": "2026/01/01\n"})

    assert response.status_code == 400
    assert "YYYY-MM-DD" in response.json()["detail"]


def test_delete_holiday_removes_date(tmp_path, monkeypatch):
    holiday_file = tmp_path / "holidays.txt"
    holiday_file.write_text("2026-01-01\n2026-01-05\n", encoding="utf-8")
    monkeypatch.setattr(main_module, "HOLIDAYS_FILE_PATH", holiday_file)

    response = client.delete("/api/holidays/2026-01-01")

    assert response.status_code == 200
    assert response.json()["holidays"] == ["2026-01-05"]
    assert holiday_file.read_text(encoding="utf-8") == "2026-01-05\n"


def test_delete_holiday_rejects_invalid_format(tmp_path, monkeypatch):
    holiday_file = tmp_path / "holidays.txt"
    monkeypatch.setattr(main_module, "HOLIDAYS_FILE_PATH", holiday_file)

    response = client.delete("/api/holidays/invalid-date")

    assert response.status_code == 400



def test_add_business_trip_upserts_date_with_type(tmp_path, monkeypatch):
    trip_file = tmp_path / "business_trips.txt"
    trip_file.write_text("2026-01-01,day_trip\n", encoding="utf-8")
    monkeypatch.setattr(main_module, "BUSINESS_TRIPS_FILE_PATH", trip_file)

    response = client.post(
        "/api/business-trips",
        json={"date": "2026-01-01", "type": "normal_trip"},
    )

    assert response.status_code == 200
    assert response.json()["business_trips"] == [
        {"date": "2026-01-01", "type": "normal_trip"}
    ]
    assert trip_file.read_text(encoding="utf-8") == "2026-01-01,normal_trip\n"


def test_business_trip_previous_day_alias_becomes_day_trip(tmp_path, monkeypatch):
    trip_file = tmp_path / "business_trips.txt"
    trip_file.write_text("2026-01-01,previous_day\n", encoding="utf-8")
    monkeypatch.setattr(main_module, "BUSINESS_TRIPS_FILE_PATH", trip_file)

    response = client.get("/api/business-trips")

    assert response.status_code == 200
    assert response.json()["business_trips"] == [
        {"date": "2026-01-01", "type": "day_trip"}
    ]
    assert trip_file.read_text(encoding="utf-8") == "2026-01-01,day_trip\n"


def test_update_business_trips_raw_rejects_invalid_type(tmp_path, monkeypatch):
    trip_file = tmp_path / "business_trips.txt"
    monkeypatch.setattr(main_module, "BUSINESS_TRIPS_FILE_PATH", trip_file)

    response = client.put(
        "/api/business-trips/raw",
        json={"raw_text": "2026-01-01,overnight\n"},
    )

    assert response.status_code == 400
    assert "normal_trip or day_trip" in response.json()["detail"]


def test_get_synonyms_proxies_external_service(monkeypatch):
    class MockResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"groups": [["PC", "パソコン"], ["AI", "人工知能"]]}

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url):
            assert url == main_module.SYNONYM_API_URL
            return MockResponse()

    monkeypatch.setattr(main_module.httpx, "AsyncClient", MockAsyncClient)

    response = client.get("/api/synonyms")

    assert response.status_code == 200
    assert response.json() == {"groups": [["PC", "パソコン"], ["AI", "人工知能"]]}


def test_get_synonyms_returns_bad_gateway_on_upstream_error(monkeypatch):
    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url):
            request = httpx.Request("GET", url)
            raise httpx.ConnectError("boom", request=request)

    monkeypatch.setattr(main_module.httpx, "AsyncClient", MockAsyncClient)

    response = client.get("/api/synonyms")

    assert response.status_code == 502
    assert response.json()["detail"] == "failed to fetch synonyms"
