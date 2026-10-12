"""
リンクAPI（/api/links）のテスト。
"""


def test_link_crud_roundtrip(client):
    created = client.post("/api/links", json={"source": 1, "target": 2}).json()
    assert created["type"] == 0

    updated = client.put(
        f"/api/links/{created['id']}",
        json={"source": 2, "target": 3, "type": 1},
    ).json()
    assert updated == {"id": created["id"], "source": 2, "target": 3, "type": 1}
    assert client.get("/api/links").json() == [updated]

    assert client.delete(f"/api/links/{created['id']}").status_code == 200
    assert client.get("/api/links").json() == []


def test_missing_link_returns_404(client):
    assert client.put("/api/links/999", json={"source": 1, "target": 2}).status_code == 404
    assert client.delete("/api/links/999").status_code == 404


def test_each_link_modification_increments_sequence(client):
    def sequence() -> int:
        return client.get("/api/tasks/update-sequence").json()["sequence"]

    link_id = client.post("/api/links", json={"source": 1, "target": 2}).json()["id"]
    assert sequence() == 1

    client.put(f"/api/links/{link_id}", json={"source": 1, "target": 3})
    assert sequence() == 2

    client.delete(f"/api/links/{link_id}")
    assert sequence() == 3
