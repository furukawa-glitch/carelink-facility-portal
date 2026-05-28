@echo off
cd /d "C:\Users\houka\OneDrive\デスクトップ\CareLink_AI"
set PYTHONUNBUFFERED=1
py "integrations\slack_jgrants_qa_bot.py" --debug
