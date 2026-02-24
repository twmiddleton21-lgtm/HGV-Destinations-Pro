# HGV Destinations Pro (static HTML/JS)

## Run locally
- Use VS Code Live Server, or any static server.
- Open `index.html`.

## Features
- Splash loading screen with animated truck
- Search + filter destinations
- Destination detail page with photos + gate info + facilities
- Navigate button (best-effort TomTom deep link + Google/Apple Maps fallback)
- Submit destination template (stored locally for review)
- Admin dashboard (hidden: tap logo 7 times -> admin view, PIN required)
- Approve & publish submissions into destinations (stored locally)

## Notes
This is a static prototype. For real production:
- Use server-side authentication for admin
- Store submissions & photos in a backend (Firebase/Supabase/etc.)
- Do not hardcode pins in client code


## Default admin
- Username: admin
- Password: admin123
(First login forces a password change.)
