name: Collect prices

on:
  schedule:
    - cron: "*/30 * * * *"   # every 30 minutes
  workflow_dispatch:          # also lets you run it by hand

permissions:
  contents: write

concurrency:
  group: price-data        # collect and backfill wait for each other, never run together
  cancel-in-progress: false

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: python collect.py
        env:
          TWELVEDATA_KEY: ${{ secrets.TWELVEDATA_KEY }}
      - name: Build the track record
        run: python track.py
        continue-on-error: true      # a problem here must never stop the price collection
      - name: Commit data
        run: |
          git config user.name "price-bot"
          git config user.email "price-bot@users.noreply.github.com"
          git add data
          git diff --cached --quiet || git commit -m "Add prices"
          git push || (git pull --rebase && git push)
