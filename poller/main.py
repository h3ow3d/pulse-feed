import json
import os
import time

def lambda_handler(event, context):
    # placeholder: just proves the schedule -> lambda path works
    return {
        "status": "ok",
        "message": "ingestor heartbeat",
        "time": int(time.time()),
        "event_preview": str(event)[:200]
    }
