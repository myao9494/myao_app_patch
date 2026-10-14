"""
休日・出張日API（/api/holidays, /api/business-trips）のテスト。
データファイルは conftest.py により一時ディレクトリへ差し替えられている。
"""
import pytest

from services import calendar_files


@pytest.fixture
def holiday_file():
    return calendar_files.HOLIDAYS_FILE_PATH


@pytest.fixture
def trip_file():
    return calendar_files.BUSINESS_TRIPS_FILE_PATH


# --- 休日 ---

def test_get_holidays_creates_empty_file_when_missing(client, holiday_file):
    response = client.get("/api/holidays")

    assert response.json() == {"holidays": [], "raw_text": "", "file_path": str(holiday_file)}
    assert holiday_file.read_text(encoding="utf-8") == ""


def test_get_holidays_returns_file_contents(client, holiday_file):
    holiday_file.write_text("2026-01-01\n2026-01-02\n", encoding="utf-8")

    body = client.get("/api/holidays").json()

    assert body["holidays"] == ["2026-01-01", "2026-01-02"]
    assert body["raw_text"] == "2026-01-01\n2026-01-02"


def test_get_holidays_normalizes_unsorted_duplicated_file(client, holiday_file):
    holiday_file.write_text("2026-01-05\n\n2026-01-01\n2026-01-05\n", encoding="utf-8")

    assert client.get("/api/holidays").json()["holidays"] == ["2026-01-01", "2026-01-05"]
    assert holiday_file.read_text(encoding="utf-8") == "2026-01-01\n2026-01-05\n"


def test_add_holiday_appends_unique_date_in_order(client, holiday_file):
    holiday_file.write_text("2026-01-05\n", encoding="utf-8")

    client.post("/api/holidays", json={"date": "2026-01-01"})
    response = client.post("/api/holidays", json={"date": "2026-01-01"})

    assert response.json()["holidays"] == ["2026-01-01", "2026-01-05"]
    assert holiday_file.read_text(encoding="utf-8") == "2026-01-01\n2026-01-05\n"


def test_delete_holiday_removes_date(client, holiday_file):
    holiday_file.write_text("2026-01-01\n2026-01-05\n", encoding="utf-8")

    response = client.delete("/api/holidays/2026-01-01")

    assert response.json()["holidays"] == ["2026-01-05"]
    assert holiday_file.read_text(encoding="utf-8") == "2026-01-05\n"


def test_update_holidays_raw_replaces_all(client, holiday_file):
    holiday_file.write_text("2026-01-01\n", encoding="utf-8")

    response = client.put("/api/holidays/raw", json={"raw_text": "2026-05-04\n2026-05-03\n"})

    assert response.json()["holidays"] == ["2026-05-03", "2026-05-04"]
    assert holiday_file.read_text(encoding="utf-8") == "2026-05-03\n2026-05-04\n"


@pytest.mark.parametrize("request_kwargs", [
    {"method": "post", "url": "/api/holidays", "json": {"date": "2026/01/01"}},
    {"method": "post", "url": "/api/holidays", "json": {"date": "2026-02-30"}},
    {"method": "put", "url": "/api/holidays/raw", "json": {"raw_text": "2026/01/01\n"}},
    {"method": "delete", "url": "/api/holidays/invalid-date"},
])
def test_invalid_holiday_dates_are_rejected_without_writing(client, holiday_file, request_kwargs):
    holiday_file.write_text("2026-01-01\n", encoding="utf-8")

    response = client.request(**request_kwargs)

    assert response.status_code == 400
    assert holiday_file.read_text(encoding="utf-8") == "2026-01-01\n"


def test_invalid_format_error_mentions_expected_format(client):
    response = client.put("/api/holidays/raw", json={"raw_text": "2026/01/01\n"})

    assert "YYYY-MM-DD" in response.json()["detail"]


# --- 出張 ---

def test_add_business_trip_upserts_date_with_type(client, trip_file):
    trip_file.write_text("2026-01-01,day_trip\n", encoding="utf-8")

    response = client.post("/api/business-trips", json={"date": "2026-01-01", "type": "normal_trip"})

    assert response.status_code == 200
    assert response.json()["business_trips"] == [{"date": "2026-01-01", "type": "normal_trip"}]
    assert trip_file.read_text(encoding="utf-8") == "2026-01-01,normal_trip\n"


def test_business_trips_are_kept_in_date_order(client, trip_file):
    client.post("/api/business-trips", json={"date": "2026-03-02", "type": "day_trip"})
    response = client.post("/api/business-trips", json={"date": "2026-03-01", "type": "normal_trip"})

    assert response.json()["raw_text"] == "2026-03-01,normal_trip\n2026-03-02,day_trip"


def test_business_trip_previous_day_alias_becomes_day_trip(client, trip_file):
    trip_file.write_text("2026-01-01,previous_day\n", encoding="utf-8")

    response = client.get("/api/business-trips")

    assert response.json()["business_trips"] == [{"date": "2026-01-01", "type": "day_trip"}]
    assert trip_file.read_text(encoding="utf-8") == "2026-01-01,day_trip\n"


def test_update_business_trips_raw_rejects_invalid_type(client):
    response = client.put("/api/business-trips/raw", json={"raw_text": "2026-01-01,overnight\n"})

    assert response.status_code == 400
    assert "normal_trip or day_trip" in response.json()["detail"]


def test_update_business_trips_raw_rejects_line_without_type(client):
    response = client.put("/api/business-trips/raw", json={"raw_text": "2026-01-01\n"})

    assert response.status_code == 400
