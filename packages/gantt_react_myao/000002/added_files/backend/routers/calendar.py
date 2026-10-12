"""
休日・出張日APIルーター。
データは backend/data/ 配下のテキストファイルに保存する（services/calendar_files.py）。
"""
from fastapi import APIRouter, HTTPException

from schemas import (
    BusinessTripCreateRequest,
    BusinessTripListResponse,
    BusinessTripRawUpdateRequest,
    HolidayCreateRequest,
    HolidayListResponse,
    HolidayRawUpdateRequest,
)
from services import calendar_files
from services.calendar_files import CalendarValidationError

router = APIRouter(prefix="/api", tags=["calendar"])


def _bad_request(exc: CalendarValidationError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


def _holiday_response(holidays: list[str], raw_text: str) -> dict:
    return {
        "holidays": holidays,
        "raw_text": raw_text,
        "file_path": str(calendar_files.HOLIDAYS_FILE_PATH),
    }


def _business_trip_response(entries: list[dict[str, str]], raw_text: str) -> dict:
    return {
        "business_trips": entries,
        "raw_text": raw_text,
        "file_path": str(calendar_files.BUSINESS_TRIPS_FILE_PATH),
    }


@router.get("/holidays", response_model=HolidayListResponse)
def get_holidays():
    try:
        return _holiday_response(*calendar_files.load_holidays())
    except CalendarValidationError as exc:
        raise _bad_request(exc) from exc


@router.post("/holidays", response_model=HolidayListResponse)
def add_holiday(request: HolidayCreateRequest):
    try:
        new_date = calendar_files.validate_date(request.date)
        holidays, _ = calendar_files.load_holidays()
        return _holiday_response(*calendar_files.save_holidays([*holidays, new_date]))
    except CalendarValidationError as exc:
        raise _bad_request(exc) from exc


@router.put("/holidays/raw", response_model=HolidayListResponse)
def update_holidays_raw(request: HolidayRawUpdateRequest):
    try:
        holidays = calendar_files.parse_holiday_lines(request.raw_text or "")
        return _holiday_response(*calendar_files.save_holidays(holidays))
    except CalendarValidationError as exc:
        raise _bad_request(exc) from exc


@router.delete("/holidays/{date}", response_model=HolidayListResponse)
def delete_holiday(date: str):
    try:
        target_date = calendar_files.validate_date(date)
        holidays, _ = calendar_files.load_holidays()
        remaining = [holiday for holiday in holidays if holiday != target_date]
        return _holiday_response(*calendar_files.save_holidays(remaining))
    except CalendarValidationError as exc:
        raise _bad_request(exc) from exc


@router.get("/business-trips", response_model=BusinessTripListResponse)
def get_business_trips():
    try:
        return _business_trip_response(*calendar_files.load_business_trips())
    except CalendarValidationError as exc:
        raise _bad_request(exc) from exc


@router.post("/business-trips", response_model=BusinessTripListResponse)
def add_business_trip(request: BusinessTripCreateRequest):
    """指定日の出張を登録する。同じ日付が既にあれば種別を上書きする。"""
    try:
        new_entry = {
            "date": calendar_files.validate_date(request.date),
            "type": calendar_files.validate_business_trip_type(request.type),
        }
        entries, _ = calendar_files.load_business_trips()
        return _business_trip_response(*calendar_files.save_business_trips([*entries, new_entry]))
    except CalendarValidationError as exc:
        raise _bad_request(exc) from exc


@router.put("/business-trips/raw", response_model=BusinessTripListResponse)
def update_business_trips_raw(request: BusinessTripRawUpdateRequest):
    try:
        entries = calendar_files.parse_business_trip_lines(request.raw_text or "")
        return _business_trip_response(*calendar_files.save_business_trips(entries))
    except CalendarValidationError as exc:
        raise _bad_request(exc) from exc
