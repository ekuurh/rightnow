# right now.

A BeReal-style daily photo app for a group of friends. Once a day, at the same random time for everyone (between 10:00 and 22:00), you get two minutes to post a back-camera shot plus a selfie. Others' photos stay blurred until you post yours. Posts show how late you were, and friends can react and comment. The last 30 days are browsable.

## How it's built

- `public/index.html`: the whole front end (no build step).
- `server.js`: a small Node server with no dependencies. It serves the page, stores data in `DATA_DIR/db.json` and saves photos as files in `DATA_DIR/photos/`. Days older than 35 days are cleaned up automatically.
- Sign-in: people join by entering a name and get a long-lived cookie. Each browser/device is its own account.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `APP_PASSWORD` | Group password needed to join. Strongly recommended, otherwise anyone with the URL can join. |
| `ADMIN_PASSWORD` | Joining with this password (instead of the group password) makes you an admin, which adds a "Drop it now" button before the daily moment. Optional. |
| `DATA_DIR` | Where data and photos are stored. Defaults to `./data`. |
| `PORT` | Set by Render automatically. |

## Run locally

```sh
APP_PASSWORD=friends ADMIN_PASSWORD=boss npm start
# open http://localhost:3000
```

The camera needs HTTPS (or localhost). Where it's blocked, the app falls back to the phone's own camera via file upload.

## Deploy to Render

1. In Render, choose **New → Blueprint** and select this repository. `render.yaml` sets up a Node web service with a 1 GB persistent disk at `/var/data`.
2. When prompted, fill in `APP_PASSWORD` (and optionally `ADMIN_PASSWORD`).
3. Share the `onrender.com` URL and the group password with your friends.

Persistent disks need a paid instance (the blueprint uses `starter`). On the **free** plan, remove the `disk:` block and `DATA_DIR` from `render.yaml`. The app works the same, but all posts, photos and accounts are wiped whenever the service restarts or spins down after inactivity.
