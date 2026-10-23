# right now.

A BeReal-style daily photo app: once a day, at the same random time for everyone (10:00–22:00 local), you get two minutes to post a back-camera + selfie shot.

Originally built as a Claude artifact. The whole app is `index.html`.

## Deploying to Render

`render.yaml` defines a static site that serves this folder. In Render, choose **New → Blueprint** and point it at this repo (or create a **Static Site** with publish directory `.` and no build command).

## Note on the backend

The page gets its database (`db`), sign-in (`user`) and photo storage (`assets`) from the Claude artifact runtime (`window.claude.use(...)`). Outside Claude those aren't present, so on Render the page loads but shows "Open this in Claude to join in" and posting is disabled. Running it standalone needs a small backend that provides those three pieces.
