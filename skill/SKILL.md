---
name: eee-review
description: Send a plan, spec or code change to the user's Eee Note tablet for a pen-and-paper review and work through their handwritten marks round by round. Use when the user asks to review something on the tablet ("schick mir das Spec zum Review", "lass mich den Code reviewen", "review on the Eee Note").
---

# Reviewing on the Eee Note

The user reads on an old grayscale pen tablet. They circle or underline what they mean and
write notes by hand beside it. eee-review carries documents to the tablet and brings the marks
back.

## Tools

Use the eee-review MCP tools when you have them. Otherwise use the CLI, which does the same:

| MCP tool | CLI |
|---|---|
| `review_create` | `eee-review agent create` with the arguments as JSON on stdin |
| `review_fetch` | `eee-review agent fetch <id>` |
| `review_respond` | `eee-review agent respond <id>` with `{replies, ...}` as JSON on stdin |
| `review_add_context` | `eee-review agent context <id> <file...>` |
| `review_close` | `eee-review agent close <id>` |
| `review_list` | `eee-review agent list` |

For example:

```sh
eee-review agent create <<'JSON'
{"title": "Login refactor", "kind": "code", "repo": "/abs/path/to/project", "base": "HEAD"}
JSON
```

The CLI prints what the MCP tools return. It writes images, the handwritten notes and page cuts,
to PNG files and prints `[Bild: <path>]` where each one belongs. Open every one of them with
your file reading tool before you answer. If `eee-review` is not on the PATH, run
`node <eee-review checkout>/src/cli.mjs agent ...`.

## Starting

- A spec or plan: `review_create` with `kind: "spec"` and the markdown files. Mermaid blocks
  are rendered as images; any other file is shown whole with line numbers.
- Code: `review_create` with `kind: "code"`. Without `head` it shows the working tree against
  `base` (default `HEAD`), new files included. With `base` and `head` it shows what `head`
  changed since it branched off `base`, as a pull request does. When the user names files or
  folders, pass them as `files`: the review then shows only their changes, and a named file
  without changes is shown whole.
- Give it a short title. It is what the user sees in the tablet's inbox.
- Pass `repo` as the project's absolute path unless you know the tool runs inside the project.
  Kiro starts it elsewhere; without `repo` the call then fails and asks for it.

## Comments

`review_create` and `review_respond` take `comments`, shown as boxes in the documents:

- With `file` and `line` a comment sits below that line, in the diff and in the whole file.
  `side: "old"` puts it on a removed line of the diff. A line the review does not show moves
  the comment to the end of the file's document.
- With `file` alone it leads that file's documents. Without `file` it goes on the overview.
- `author` and `text` are required. `at` is a date to show, and `replies` is the thread under it.
  `ref` is your handle for it, such as the platform's comment id. It comes back with any mark
  on the comment.

`overview` is markdown that opens the review as a document of its own, ahead of the files.
Comments without a file follow it.

Use comments for what belongs next to the code: remarks from colleagues, and your own notes
for the user, such as "this is the one change that affects callers". Keep them short. Your
reasoning belongs in replies.

A mark on a comment comes back with the comment in its text: `[Kommentar <ref> von <author>
zu <file>:<line>] ...`. It means the user is answering or judging that comment.

`review_respond` replaces the comments when you pass them, and keeps them when you leave them
out. Pass the whole list each time, updated, for example with a colleague's new reply.

## Pull requests

When the user asks you to bring a pull request (Bitbucket, GitHub, ...) to the tablet:

1. Fetch the PR with your own access to the platform: its details, its comments and threads,
   and its source and target branches.
2. Fetch both branches into the local clone, without touching the user's working tree
   (`git fetch origin <source> <target>`). Only check the branch out if the user asks for that.
3. Call `review_create` with `kind: "code"`, `base` as the target branch (such as
   `origin/main`) and `head` as the PR's source commit.
   - `overview`: the PR's title, author, branches, state, reviewers and approvals, link, and
     description, as markdown.
   - `comments`: every comment, with inline comments at their file and line and replies as
     their thread. Set `ref` to the platform's comment id.
   - Leave out comments that are resolved or outdated unless the user wants them.
4. Review round by round as usual.
5. Post nothing on the PR until the user says so. Then draft the PR comments from the marks and
   pass them as `drafts` to `review_respond`, together with your replies.
   - Inline comments carry the file and line of their mark.
   - A mark on a colleague's comment becomes a reply in that thread: set `ref` to that comment's
     `ref`.
   - The drafts appear on the tablet as a document of their own, one box each. The user stamps
     each one: OK to post it, Nein to drop it, or a note to change it.
   - `review_fetch` then lists every draft with its verdict. Post exactly the approved ones, with
     their text. Revise the ones with a note and show them again in the next round. Never post
     one that was not approved.
   - If the review is already closed, show the drafts in the chat and wait for approval there.
   - Write them in the user's voice and language, not as notes about the review.
   - Keep each draft close to the user's note: their wording, their length, nothing added.
     Details from the thread or the code that the note does not say stay out of the draft.

## Getting the round

Don't wait or poll after creating or answering a review. Tell the user it is on the tablet and
stop. They tell you when they have sent the round, or when they asked a question mid-review.
Then call `review_fetch` once. If it says there is nothing new yet, tell the user and wait for
their next message. Use `review_wait`, which blocks, only if the user asks you to wait.

## Reading the marks

Each mark comes with where it sits (file, kind of view, source lines), the text under the ink,
an optional stamp, and the handwritten note as an image. Marks made on the tablet also come
with a cut of the page: the ink in black over the lightened page. Use it to see exactly what was
circled or underlined, such as a single word or argument, where the lines alone are too coarse.

- Stamp OK means agreed and Nein means rejected. The question-mark stamp means it is unclear or
  needs explaining.
- Read every note carefully. Before acting on a note, state how you read it, because
  handwriting is easy to misread. Your reading goes back to the tablet with your reply, so
  the user can correct it.
- A mark with no note and only a stamp is complete in itself.

## Context requests

When `review_fetch` returns "Fragen", the user is still reading and asked for more. Their note
says what they need, for example "wo wird das aufgerufen?" or "zeig mir den SessionService".
Find the files and call `review_add_context`. Don't answer in prose; they are reading on the
tablet, not in the terminal.

## Answering

1. Make the changes the marks call for in the files.
2. Call `review_respond` with one reply per mark. `mark` is the mark's number. Each reply holds
   your reading of the note and what you did or why not.
3. This starts the next round. The files are rendered again and your replies come first.
4. Tell the user, and fetch again when they say they have sent it.

Repeat until the user sends a round with nothing left to discuss, or tells you it's done. Then
call `review_close`.
