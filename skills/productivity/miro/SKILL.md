---
name: miro
description: Read and arrange a Miro whiteboard through a bundled REST API v2 CLI — list boards, place cards, sticky notes, text, shapes, frames, connectors and uploaded images (PNG/JPG/SVG/GIF, e.g. a note rendered to PNG) at coordinates, tag items, and return deep links. Use when asked to put content on a Miro board, lay out a visual map in Miro, or look up what a Miro board holds. Miro is only the map; the Markdown notes stay the source of truth.
---

# Miro

Drive Miro with `node <skill dir>/scripts/miro.mjs <command>`. It needs only Node (built-in `fetch`) and runs the same on Windows and WSL/Linux. Every command prints JSON on stdout; on failure it prints `miro: <reason>` on stderr and exits non-zero (1 for API or validation errors, 2 for usage errors). Talk to the user in Traditional Chinese.

**Miro is a view, not the record.** The Markdown (for example growth's notes) is canonical: write there first, then mirror onto the board, and put the item's `deep_link` back into the note when useful. Never treat board content as the only copy.

## Token

Read in this order; neither is ever printed:

1. Environment variable `MIRO_ACCESS_TOKEN`.
2. A file holding only the token on one line: Windows `%USERPROFILE%\.config\miro\token`, WSL/Linux/macOS `~/.config/miro/token`.

When neither exists the CLI exits 1 and names both. Do not ask the user to paste the token into chat; tell them to create the file (readable only by themselves). Never write a token into a repo, note, test or example — use `<token>`.

## Commands

```
boards list [--limit N]
boards get <board>
boards create --name <name> [--description <text>] [--team <team_id>] --confirm
boards update <board> [--name <name>] [--description <text>]
items list <board> [--type card|sticky_note|text|shape|frame|connector|image] [--parent <frame>] [--limit N]
items get <board> <item>
items create <board> --type <type> [fields]
items update <board> <item> [--type <type>] [fields]
items delete <board> <item> --confirm
images create <board> --file <png|jpg|svg|gif> [--parent <frame>] [--x N --y N] [--width N | --height N] [--title <text>] [--alt-text <text>]
images update <board> <item> --file <new file> [same fields as create]
images get <board> <item>
tags list <board> [--item <item>]
tags create <board> --title <name> [--color <colour>]
tags attach <board> <item> <tag>
tags detach <board> <item> <tag>
```

Fields: `--content`, `--title`, `--description`, `--shape`, `--fill-color`, `--x`, `--y`, `--width`, `--height`, `--parent <frame>`; connectors take `--start <item> --end <item>` and optional `--caption`, `--shape straight|elbowed|curved`. `--data '<json>'` and `--style '<json>'` merge any other Miro field. Negative numbers need `=`: `--x=-400`.

- Which field each type uses: card `--title`/`--description`; sticky_note, text, shape `--content`; frame `--title` (created as a freeform frame). Coordinates are board coordinates of the item's centre; with `--parent` they are relative to the frame's top-left.
- `items update` without `--type` only moves (`--x`/`--y`) or re-parents (`--parent`); any other field needs `--type`.
- Lists follow pagination to the end; `--limit N` stops after N items.
- Every item in the output carries `deep_link`: `https://miro.com/app/board/<board_id>/?moveToWidget=<item_id>`. Give that link to the user.
- Tag colours: only `red light_green cyan yellow magenta green blue gray violet dark_green dark_blue black` (Miro rejects anything else, `orange` included, with HTTP 400). Without `--color` the CLI sends `blue`; any other name is refused locally with exit 2 and the list.
- `items create --type image` is refused; images go through `images create` (multipart upload: the file as `resource`, the fields as a JSON `data` part).
- `images update` sends `PATCH /v2/boards/<board>/images/<item>` with the new file, replacing the picture in place: the item id, deep link, tags and connectors stay. Omitted fields keep their current value.
- Images take `--width` or `--height`, not both; Miro keeps the aspect ratio.
- `boards update` renames the board or changes its description (PATCH); it never creates one.
- Tags show on cards and sticky notes (up to 8 each); the board shows API tag changes only after a refresh.

## Guards

- **Never create a board on your own.** The owner is on the Free plan with only 3 editable boards. Use an existing board from `boards list`; run `boards create … --confirm` only when the user explicitly asks for a new board.
- `items delete` needs `--confirm`. Before deleting, show the user what will go (`items get`) unless they named the exact item.
- Text fields are checked locally before sending: shorter than 6000 characters, and only `p a strong b em i u s span ol ul li br` tags. A violation exits 1 naming the field and tags; fix the text rather than retrying.
- Image files are checked locally before sending: the file exists, the extension is `.png .jpg .jpeg .svg .gif`, the first bytes match that extension, it is not empty, and it is at most 6 MiB (Miro's documented limit is "6 MB"; Miro's API docs list no accepted formats, so the four above are this CLI's choice). A violation exits 1 and names the file; fix the file rather than retrying.
- `--dry-run` prints the request (method, URL, body or for images a `multipart` summary of each part — file name, size, content type, `data` JSON —, `Authorization: Bearer <redacted>`) without sending and without a token. Use it to preview a large layout before writing.
- HTTP 429 is retried with `Retry-After` or exponential backoff, up to 5 times; then it exits 1. Do not loop on it yourself.

## Laying out a map

1. `boards list` → pick the board; `items list <board> --type frame` to see existing sections.
2. Create a frame per section, then items inside it with `--parent <frame>` and a grid of `--x/--y` (for example 250-unit steps for sticky notes).
3. Link related items with `items create <board> --type connector --start <a> --end <b>`.
4. Tag status (`tags create` once, then `tags attach`).
5. Report the frame's and key items' `deep_link`s.

Example:

```
node <skill dir>/scripts/miro.mjs items create <board> --type sticky_note --parent <frame> --x 125 --y 125 --content "<p><strong>題目</strong> 練習一</p>"
```

## Putting a note on the board as an image

For a note whose layout matters more than editable text (for example a growth note with code or a diagram):

1. Render the Markdown note to PNG outside this CLI, at a stable path next to the note (for example `<note>.png`). Keep it under 6 MiB.
2. First time: `images create <board> --file <note>.png --parent <frame> --x … --y … --width 800 --title "<note title>"`. Write the returned `id` and `deep_link` into the note (for example front matter `miro_image: <id>`).
3. After the note changes: render again and run `images update <board> <id> --file <note>.png`. Do not run `images create` again for the same note — every create adds another copy to the board.
4. If the note has no recorded id, look first: `items list <board> --type image` (or `--parent <frame>`) and match by title before creating.

The note stays the source of truth; the image is a snapshot of it.
