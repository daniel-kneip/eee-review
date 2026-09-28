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
  `base` (default `HEAD`), new files included. With `base` and `head` it shows what `head`
  changed since it branched off `base`, as a pull request does. When the user names files or
  folders, pass them as `files`: the review then shows only their changes, and a named file
  without changes is shown whole.
- Give it a short title. It is what the user sees in the tablet's inbox.
- Pass `repo` as the project's absolute path unless you know the MCP server runs inside the
  project. Kiro starts it elsewhere; without `repo` the call then fails and asks for it.

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
   show them to the user in the next round's replies, or in the chat if the review is closed.
   - Inline comments go at the file and line of their mark.
   - A mark on a colleague's comment becomes a reply in that thread, by its `ref`.
   - Post them once the user approves the drafts.
   - Write them in the user's voice and language, not as notes about the review.
   - Keep each draft close to the user's note: their wording, their length, nothing added.
     Details from the thread or the code that the note does not say stay out of the draft.


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
