# Spotify Controller

See what's playing on Spotify and control it: previous track, rewind 10s, play/pause, skip.
Includes a version for **Even Realities G2** glasses.

```
docs/                  ← the website (this is what GitHub Pages serves)
  index.html, app.js   ← main controller (phone / PC browser)
  spotify.js           ← shared Spotify login + controls
  config.js            ← put your Spotify Client ID here
  glasses/             ← glasses version (opened from the Even app)
server.js              ← optional: test locally with `npm start`
```

## 1. Put it on GitHub Pages
1. Create a new **public** repository on github.com, e.g. `spotify-controller`.
2. Click **Add file → Upload files** and drag in: the `docs` folder, `server.js`, `package.json`, `README.md`.
   (You don't need `.claude` or `package-lock.json`.) Click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**,
   branch **main**, folder **/docs**, and click **Save**.
4. After a minute your site is live at:
   - Main: `https://<username>.github.io/spotify-controller/`
   - Glasses: `https://<username>.github.io/spotify-controller/glasses/`

## 2. Set up Spotify
1. https://developer.spotify.com/dashboard → **Create app**, tick **Web API**.
2. Add **both** Redirect URIs exactly (including the trailing `/`):
   - `https://<username>.github.io/spotify-controller/`
   - `https://<username>.github.io/spotify-controller/glasses/`
3. Copy the **Client ID** into `docs/config.js` (edit it on GitHub with the pencil icon):
   `export const CLIENT_ID = "your-client-id";`

## 3. Open it on your glasses (G2)
1. Sign in at https://hub.evenrealities.com with your Even account. Then force-close and reopen
   the Even app on your phone; a developer section appears in the Even Hub tab.
2. On your PC: `npm install -g @evenrealities/evenhub-cli`
3. Run: `evenhub qr --url "https://<username>.github.io/spotify-controller/glasses/"`
4. Scan the QR code from the Even app's developer section.
5. On the phone screen, tap **Connect with Spotify** and log in (first time only).

**On the glasses:** scroll up/down to highlight a button, tap to press it, double-tap to exit.

## Notes
- Controlling playback requires **Spotify Premium**.
- Spotify must be open and playing on some device.
- Test locally with `npm start`, then open http://127.0.0.1:8888/ (add `http://127.0.0.1:8888/`
  and `http://127.0.0.1:8888/glasses/` as Redirect URIs too).
- Opening `/glasses/` in a normal browser shows a live preview of the glasses screen
  (use ↑/↓ and Enter).
