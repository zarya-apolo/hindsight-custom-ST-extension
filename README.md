# Hindsight Memory — SillyTavern extension

This is an independent browser-only SillyTavern extension. It does not modify SillyTavern core, remote servers, or other extensions.

## Features

- **Memory bank selection modes**:
  - `Auto`: Resolves one isolated Hindsight bank per SillyTavern conversation (`st-chat-<chat_id>`), identified cleanly in the UI by chat name and ID (with collision-safe hashing if special characters are present).
  - `Character card`: Resolves one persistent bank whose bank ID is the exact SillyTavern character card name `{{char}}` (including disambiguation suffixes such as `(1)`). Fails safe to per-chat Auto if no card is present (e.g. group chat).
  - `Custom`: Lists live banks via `GET /v1/default/banks` and lets you select any existing bank (including legacy `sillytavern`).
- **Segmented transcript documents**:
  - Automatic transcripts are divided into stable segments (default: 15 non-system chat + character messages per document).
  - The current open segment is a local buffer. It is not sent to Hindsight until the conversation advances into the next segment, so edits, deletions, swipes, and regenerations in the current block do not trigger network requests.
  - Closed segments are sent as complete documents. Mutations to an already-sent segment use an isolated `replace` on that document only.
  - Managed document deletion: removing messages or truncating chats automatically deletes orphaned automatic segment documents via `DELETE /v1/default/banks/{bank}/documents/{document_id}` without touching any bank.
  - Global 120,000-character truncation has been removed.
- **Creation-time threshold**:
  - Segmentation threshold applies only to newly created and open segments. Past closed segments retain their creation-time threshold.
- **Explicit LLM memory protection**:
  - The `hindsight_retain` tool creates independent memory documents (omits `document_id`), keeping explicit memories uncoupled from automatic transcript segmentation.
- **Independent readiness**:
  - Backend operations (memory retain/recall/reflect/tools and listing banks) depend only on Hindsight backend URL + Enabled status.
  - LLM Provider base URL and API key are needed only for discovering provider models and writing provider configurations.
- **Unified routing & race safety**:
  - Automatic recall, reflect, LLM tools (`hindsight_recall`, `hindsight_reflect`, `hindsight_retain`), and model settings route through the single active bank resolver.
  - Pre-fetch and post-fetch race checks prevent outdated responses or cross-chat memory leaks during asynchronous operations.
- **Live Memory State Indicator**:
  - Displays active bank, bank mode, automatic segments including the local buffer, current segment position (`X/Y (N/15 msgs)`), and total tracked messages.

## Legacy Compatibility & Migration Note

- Existing banks (such as `sillytavern`) and prior documents are never silently migrated, deleted, or altered.
- Custom mode allows selecting legacy banks directly.
- The segmentation threshold setting applies to newly created and currently open automatic documents, not past closed segments. The current open segment is buffered locally until the next segment begins.
