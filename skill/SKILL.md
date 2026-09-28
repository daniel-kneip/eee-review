---
name: eee-review
description: Send a plan, spec or code change to the user's Eee Note tablet for a pen-and-paper review and work through their handwritten marks round by round. Use when the user asks to review something on the tablet ("schick mir das Spec zum Review", "lass mich den Code reviewen", "review on the Eee Note").
---

# Reviewing on the Eee Note

The user reads on an old grayscale pen tablet. They circle or underline what they mean and
write notes by hand beside it. The eee-review MCP tools carry documents to the tablet and bring
the marks back.

## Starting

- A spec or plan: `review_create` with `kind: "spec"` and the markdown files. Mermaid blocks
  are rendered as images; any other file is shown whole with line numbers.
- Code: `review_create` with `kind: "code"`. Without `head` it shows the working tree against
  `base` (default `HEAD`), new files included. With `base` and `head` it shows the change between
  two commits. When the user names files or folders, pass them as `files`: the review then shows
  only their changes, and a named file without changes is shown whole.
- Give it a short title. It is what the user sees in the tablet's inbox.
- Pass `repo` as the project's absolute path unless you know the MCP server runs inside the
  project. Kiro starts it elsewhere; without `repo` the call then fails and asks for it.

## Waiting

Call `review_wait` right after creating the review. It returns when the user sends the round,
or earlier when they ask for context mid-review. It returns "wartet noch" after its timeout;
then call it again. Don't do other work in between unless the user asked you to.

## Reading the marks

Each mark comes with where it sits (file, kind of view, source lines), the text under the ink,
an optional stamp, and the handwritten note as an image.

- Stamp OK means agreed and Nein means rejected. The question-mark stamp means it is unclear or
  needs explaining.
- Read every note carefully. Before acting on a note, state how you read it, because
  handwriting is easy to misread. Your reading goes back to the tablet with your reply, so
  the user can correct it.
- A mark with no note and only a stamp is complete in itself.

## Context requests

When `review_wait` returns "Fragen", the user is still reading and asked for more. Their note
says what they need, for example "wo wird das aufgerufen?" or "zeig mir den SessionService".
Find the files and call `review_add_context`, then call `review_wait` again. Don't answer in
prose; they are reading on the tablet, not in the terminal.

## Answering

1. Make the changes the marks call for in the files.
2. Call `review_respond` with one reply per mark. `mark` is the mark's number. Each reply holds
   your reading of the note and what you did or why not.
3. This starts the next round. The files are rendered again and your replies come first.
4. Call `review_wait` again.

Repeat until the user sends a round with nothing left to discuss, or tells you it's done. Then
call `review_close`.
