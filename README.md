# Guitar Tabs

A small web app for your own server. You upload plain-text guitar tab files
(`.tab`, the kind typed with dashes and numbers) and it shows them as drawn
tab staves: six lines, the string names on the left, the fret numbers on the
lines, and bar lines.

It needs Node.js 20 or newer and nothing else. There are no packages to install.

## Start it

Clone the repository and, in its folder, run:

```sh
npm start
```

Then open <http://localhost:5678>, or `http://<address of the server>:5678`
from another device on your network.

- `PORT=8080 npm start` uses another port.
- `HOST=127.0.0.1 npm start` makes the app reachable from the server itself
  only. By default it listens on all network interfaces.
- If the firewall (`ufw`) is on, other devices cannot reach the app until the
  port is opened for your network. With your own network range in place of
  `192.168.1.0/24`:
  `sudo ufw allow from 192.168.1.0/24 to any port 5678 proto tcp`

The app has no login. Anyone who can reach it can add and delete tabs, so
keep it on your home network.

## Use it

- **Upload tabs** takes one or more files (`.tab`, `.txt` or any other text
  file). You can also drop files anywhere on the page, or copy them into the
  `tabs/` folder on the server.
- Uploading never overwrites: the same file again changes nothing, and a
  different file with a name that is taken is stored as `name-2.tab`.
- **Original text** shows the file as it was typed, to compare with the drawing.
- **Print** gives a clean sheet without the list and the buttons.
- **Delete** removes the file from the `tabs/` folder.

Files can be up to 1 MB and must be text.

The `tabs/` folder is created on the first upload. It is listed in
`.gitignore`, so your own tabs stay out of the repository.

## How a file is read

Tab files are typed by hand and follow no fixed format, so the app looks for
lines that are mostly dashes and groups neighbouring ones into a staff.

- Every character keeps its column, so the spacing is the one the author typed.
- String names are taken from the file (`e|`, `Eb|`, `E-|`, `E---`). A
  six-line staff without names is labelled E B G D A E.
- Anything on a string that is not a number (`h`, `p`, `b`, `/`, `~`, `(BU)`)
  is drawn where it stands, in smaller type.
- `|:` and `:|`, or `||*`, are drawn as repeat signs.
- Lines directly above or below a staff (chords, beat counts, lyrics,
  `PM----|`) stay with it, on their columns. Other text is shown as typed.
- The notice and mail header that archives put on top of a file are folded
  away under "File header".
- A staff that is too wide for the page is first drawn tighter and then
  wrapped, at bar lines where possible.

The app draws what is in the file. It does not know note lengths, and it does
not check the tab. If a drawing looks wrong, compare it with "Original text".

## Files

| Path | What it is |
|---|---|
| `server.js` | serves the app and stores the uploaded files |
| `public/tab-parser.js` | finds the staves in the text of a tab file |
| `public/tab-render.js` | draws staves as SVG |
| `public/app.js`, `index.html`, `styles.css` | the page |
| `public/icon-48.png`, `icon-96.png` | the icon in the browser tab and the top bar |
| `tabs/` | your uploaded tab files (not in git) |
| `test/` | tests, run with `npm test` |

## Keep it running

`npm start` stops when you close the terminal. To have the app start with the
server, save this as `~/.config/systemd/user/guitar-tabs.service`:

```ini
[Unit]
Description=Guitar Tabs

[Service]
WorkingDirectory=%h/guitar-tabs
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

`%h` stands for your home folder. Change the two paths if the app is cloned
somewhere else or `which node` shows another place for Node. Then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now guitar-tabs
loginctl enable-linger "$USER"
```

From then on:

| To do this | Run |
|---|---|
| Check whether it is running | `systemctl --user status guitar-tabs` |
| Start, stop or restart it | `systemctl --user start guitar-tabs` (or `stop`, `restart`) |
| See its log | `journalctl --user -u guitar-tabs -e` |
| Remove the service again | `systemctl --user disable --now guitar-tabs` |

Restart it after changing `server.js`. Changes to the files in `public/` show
up on the next page reload.
