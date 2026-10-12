#!/bin/bash
cd "$(dirname "$0")"
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8008