# Hindsight Memory — SillyTavern extension

This is an independent browser-only SillyTavern extension. It does not modify SillyTavern core or the Honcho extension.

Features:

- Hindsight backend URL, LLM provider URL/key, bank and abstract model selector in the extension menu.
- Optional model discovery via `GET <provider-url>/models`; the model identifier is provider-agnostic and user-selected.
- Automatic non-streaming recall before each generation.
- Asynchronous full-chat retain using one stable Hindsight `document_id` per ST chat.
- Replaces the Hindsight document after edits, deletes, swipes and regenerated messages are reflected in the current ST chat.
- Three memory scopes:
  - Global: untagged memories shared by all ST chats using the bank.
  - Character: memories tagged for the current character.
  - This chat only: memories tagged for the current ST chat.
- LLM tools: `hindsight_recall`, `hindsight_reflect`, `hindsight_retain`.

Important scope behavior:

The extension uses Hindsight tags for scoped memories. In `global`, all chat documents are written to the same bank without tags, so memories can be recalled between chats. In `character` and `chat`, recall is filtered with strict tags. This makes cross-chat memory a user decision rather than a permanent yes/no design decision.

Install from the public GitHub repository URL. The extension must be configured with the Hindsight backend URL; it is never hardcoded to an IP.

The provider URL/key/model configure the LLM used by Hindsight. The Hindsight URL configures the memory backend. They are separate services.

Legacy manual install path:

`public/scripts/extensions/third-party/hindsight-custom-ST-extension`

Then restart SillyTavern and configure the extension. Hindsight API calls are intentionally non-streaming. The main ST model stream remains controlled by SillyTavern.

Model selection is persisted per Hindsight bank through Hindsight's custom endpoints:

- `GET /v1/models` lists configured server-side model deployments without credentials.
- `GET /v1/default/banks/{bank_id}/llm-model` reads the effective selection.
- `PATCH /v1/default/banks/{bank_id}/llm-model` persists the selection.

The selected bank model is used as Hindsight's default LLM model. Provider, API key, base URL, and explicit per-operation server overrides remain server-owned.
