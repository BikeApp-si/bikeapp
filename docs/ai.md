# AI in Bike

Bike uses an AI model to build and change apps: from your documents, from a request typed beside an app, and for
reports asked in words. Everyday work (forms, tables, approvals, rules, emails) asks the model almost nothing.

## Your company's Anthropic key

Bike calls Anthropic with your company's own key. An admin adds it in **Settings › AI** (or at first run); Bike
checks it with Anthropic before saving it, and keeps it encrypted with `SESSION_SECRET`. `ANTHROPIC_API_KEY` in `.env`
works too; the one in Settings › AI wins.

Settings › AI shows this month's AI use in dollars, what it was for and the newest calls, at Anthropic's list
prices (your Anthropic bill is the final word). Set a **monthly cap** there: when the month's use reaches it,
building and changing apps waits until the 1st; everyday work never stops.

## Without a key

Everything works except what needs an AI model: building and changing apps from words or documents, reports from
questions, filters in plain words, reading a dropped document into a form, and each app's How to use. Apps can come
from an app set instead (Home, **Start from an app set**). When you have a key, an admin adds it in **Settings › AI**,
where the month's AI use and a monthly cap are too.
