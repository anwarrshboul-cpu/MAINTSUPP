#!/usr/bin/env python3
"""Writes the Supabase password into .env. Run: python3 set-db-password.py

Refuses an empty password and URL-encodes special characters, which is what
broke the first attempt: an empty value still produces a valid-looking URL that
fails only when you try to connect.
"""
import getpass, pathlib, re, urllib.parse

REF, REGION = "wghfhtdzxttfhofuljyy", "aws-0-eu-west-2"

pw = getpass.getpass("Supabase database password (typing is hidden — paste, then Enter): ")
if not pw.strip():
    raise SystemExit("\nEMPTY — nothing was entered. Paste the password, then press Enter.")

safe = urllib.parse.quote(pw, safe="")
env = (
    "# Supabase — MAINTSUPP. Never commit; never paste into chat.\n"
    f'DATABASE_URL="postgresql://postgres.{REF}:{safe}@{REGION}.pooler.supabase.com:6543/postgres"\n'
    f'DATABASE_URL_DIRECT="postgresql://postgres.{REF}:{safe}@{REGION}.pooler.supabase.com:5432/postgres"\n'
)
pathlib.Path(".env").write_text(env)
print(f"\nOK — password stored, {len(pw)} characters.")
