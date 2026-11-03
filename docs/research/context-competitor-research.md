# Context-aware dictation: competitor evidence

Research date: **November 2, 2026**. Scope: public first-party product, help, and privacy documentation for Typeless, Wispr Flow, and Superwhisper. These are documented behaviors or vendor claims, not independent measurements of accuracy, data deletion, or app compatibility. No private messages, accounts, or application screens were accessed for this investigation.

The product the user calls “whisper flow” is treated here as **Wispr Flow**; Superwhisper is a separate product.

## Main finding

Current products combine application-aware formatting, nearby or selected text, explicit modes, dictionaries, and personalization. The reviewed sources do **not** establish that an app name reliably reveals whether a recipient is a friend, family member, or professor. App classification is a useful starting signal; relationship and intent require additional evidence or an explicit user choice. WoVoice should make that uncertainty visible instead of claiming to know every relationship.

## Typeless

### App adaptation and modes

Typeless’s homepage advertises different tones by application, using work email and casual chat as examples. It separately advertises personalized phrasing, dictionaries, selected-text editing, and selected-text questions. The site lists Mac, Windows, Linux, iOS, and Android, but that is a platform-availability statement—not proof that all context sources work identically on every platform. [Typeless product page](https://www.typeless.com/)

The Personalization guide says Typeless learns general style patterns, such as formality and concision, over time. It describes a progress report and a desktop setting that stops style learning and returns to non-personalized phrasing. This is a first-party account of its approach; the guide does not expose the learning algorithm, feature schema, confidence calibration, or how relationships are identified. [Personalization](https://www.typeless.com/help/quickstart/personalization)

A distinct **Help me write** workflow asks the user to say the writing purpose, recipient, and requirements, then generates a reply, email, post, or document. Its examples explicitly provide those details. This is stronger evidence for user-supplied audience context than for automatic relationship detection. [Help me write on iOS, September 22, 2026](https://www.typeless.com/help/release-notes/ios/use-help-me-write-ios)

**Speak to edit** is also a separate action: select text and give an editing instruction. Official examples include converting text into a professional email or a LinkedIn post. This is an explicit transformation workflow, not evidence that ordinary dictation should silently invent greetings, subjects, commitments, or new content. [Speak to edit](https://www.typeless.com/help/release-notes/ios/speak-to-edit)

### Context processing and privacy

Typeless’s October 13, 2026 policy describes cloud processing of audio plus limited context, including the active app and relevant text. It says these inputs are discarded after the result, with exceptions for voluntarily submitted feedback and optional History cloud sync. It also describes third-party cloud AI processing. Consequently, “zero retention” must not be paraphrased as “no cloud processing” or “no information leaves the device.” [Privacy policy](https://www.typeless.com/privacy)

Its Data Controls page separately describes local history by default, optional cloud history storage and deletion when sync is disabled, and explicit consent for shared corrections in feedback. The page states that AI partners have zero-retention terms. These are vendor commitments; they are not independently verified here. [Data controls](https://www.typeless.com/data-controls)

### Useful lesson for WoVoice

**Recommendation/inference:** separate faithful dictation, user-requested rewriting, and instruction-driven composition. Learn abstract preferences only with consent, and expose them for correction. A friend-versus-professor distinction should be a user-approved audience preference or explicit session instruction, not an opaque assumption from the messaging app.

## Wispr Flow

### Context mechanisms and limitations

The opened guide describes app/site categories, nearby text, visible names, fast fallbacks, and text-only capture. Its platform list covers Mac, Windows, and focused-field-limited iOS. Desktop context-off still sends app/domain metadata. It documents sensitive-field exclusions with custom-field caveats. These are vendor descriptions, not compatibility guarantees. [Context Awareness](https://docs.wisprflow.ai/articles/4678293671-feature-context-awareness)

The separate Styles guide documents category styles on Mac, Windows, and Android; iOS can have one default style or category tabs. Styles control capitalization, punctuation, and email formatting. Notices limit style formatting to English. Android support for category styles must **not** be equated with documented full desktop context-reading parity. [Flow Styles](https://docs.wisprflow.ai/articles/2368263928-how-to-setup-flow-styles)

Smart Formatting is described as cleaning grammar, punctuation, capitalization, and fillers; the guide specifically says it does not fix misheard words. It lists different platform controls, including formatting always applied on Android. This distinction matters when proposing “guess the word”: formatting and recognition repair are different responsibilities. [Smart Formatting & Backtrack](https://docs.wisprflow.ai/articles/5373093536-How-do-I-use-Smart-Formatting-%26-Backtrack)

### Privacy controls are separate

Wispr’s current privacy page exposes distinct controls for model improvement, cloud dictation storage, context awareness, and local history. It describes cloud transcription and configurable retention, so no blanket “Wispr stores nothing” statement is justified. Context off, training off, local-history off, and cloud-storage off are different promises. [Privacy controls](https://wisprflow.ai/privacy)

**Source conflict:** cached search text differed from the opened guide; this report uses the opened page.

### Useful lesson for WoVoice

**Recommendation/inference:** app categories, website recognition, predictable manual styles, local insertion formatting, and fast context timeout fallbacks are practical patterns. Keep platform capability labels precise. Separate the permissions to read context, send it, retain history, and learn preferences.

## Superwhisper

### Explicit context sources

Superwhisper exposes selected-text, application, and clipboard context separately. Its guide documents different capture times and warns about app switching, unnecessary disclosure, and quality degradation from irrelevant context. [Context awareness](https://superwhisper.com/docs/common-issues/context)

Custom modes expose instructions plus separate Application, Copied text, and Selected text checkboxes. The docs recommend explicitly targeting each input in the instructions. This is documented control over transformations, not a verified automatic recipient-relationship system. [Custom modes](https://superwhisper.com/docs/modes/custom)

### Data path and Android caveat

The security guide describes voice recognition and language-model processing as independently selectable local or cloud stages. It says local models for both stages keep dictation on the machine, while cloud API routes follow provider agreements; BYOK follows the user’s own agreement. It states that transcription history is local and configuration sync excludes transcript/audio content. These claims should be read as configuration-specific, not as a universal offline claim. [Sensitive Data Best Practices](https://superwhisper.com/docs/security/sensitive-data)

The Android guide documents a floating bubble, text insertion, microphone permission, optional notifications, local recording history, and phone-only support. It says modes and vocabulary are per-device and do not yet sync. That guide does not establish desktop-equivalent application/clipboard/selected-text context on Android. [Superwhisper on Android](https://superwhisper.com/docs/get-started/android)

### Useful lesson for WoVoice

**Recommendation/inference:** show exactly which context source is enabled and keep it bound to the intended editor. Capture target identity at recording start and reject stale targets rather than adopting whichever app is active after inference. Clipboard context should be an explicit user action, not an ambient default.

## Implications for a differentiated WoVoice design

These are proposed design decisions, not competitor facts:

1. Treat **app type**, **writing task**, **audience**, and **user style** as separate fields. A professor can be contacted in WhatsApp; a friend can receive a formal email.
2. Resolve intent in an explainable order: explicit session instruction → user-approved conversation preference → saved app/task preference → conservative app-category default. Missing context should produce faithful neutral cleanup.
3. Offer a compact editable indication such as `Email · Professor · Respectful · Context off`, with each assumption inspectable. Label inferred values as suggestions and user-selected values as confirmed.
4. Separate `Dictate` (preserve meaning), `Rewrite` (transform selected text), and `Compose` (generate from explicit instructions). Additional facts, emotional intensity, greetings, or promises should require the latter modes or clear user intent.
5. Use local app metadata and bounded cursor context first. Recipient/thread reading should be an optional, narrowly scoped capability, with a visible preview and a fallback when an app exposes no reliable structure.
6. Learn abstract preferences from explicit feedback with opt-in consent. Do not silently convert private conversation content into persistent cloud memory. Give users per-profile reset/delete controls.
7. Evaluate the same spoken idea across friend, professor, family, workplace, social post, code, and email contexts. Include ambiguous audiences, stale targets, sensitive fields, mixed languages, and malicious instructions embedded in context.

## Source ledger

All links were opened or retrieved from first-party domains during this investigation on November 2, 2026:

- [Typeless product](https://www.typeless.com/)
- [Typeless personalization](https://www.typeless.com/help/quickstart/personalization)
- [Typeless Help me write](https://www.typeless.com/help/release-notes/ios/use-help-me-write-ios)
- [Typeless Speak to edit](https://www.typeless.com/help/release-notes/ios/speak-to-edit)
- [Typeless privacy](https://www.typeless.com/privacy)
- [Typeless data controls](https://www.typeless.com/data-controls)
- [Wispr Context Awareness](https://docs.wisprflow.ai/articles/4678293671-feature-context-awareness)
- [Wispr Styles](https://docs.wisprflow.ai/articles/2368263928-how-to-setup-flow-styles)
- [Wispr Smart Formatting](https://docs.wisprflow.ai/articles/5373093536-How-do-I-use-Smart-Formatting-%26-Backtrack)
- [Wispr privacy controls](https://wisprflow.ai/privacy)
- [Superwhisper context](https://superwhisper.com/docs/common-issues/context)
- [Superwhisper custom modes](https://superwhisper.com/docs/modes/custom)
- [Superwhisper sensitive-data guide](https://superwhisper.com/docs/security/sensitive-data)
- [Superwhisper Android guide](https://superwhisper.com/docs/get-started/android)
