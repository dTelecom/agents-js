# Smart Turn integration and evidence

Smart Turn v3.2 classifies whether a speaker has finished, using audio at a VAD pause. It is already implemented in the selected STT server; SDK `DtelecomSTT({ smartTurn: true })` requests it. Partial transcripts are an independent option.

## What the existing acceptance test meant

The Phase 1 plan asked for at least 95% of finished sentences to end by classifier decision before the hold timeout, at least 80% of deliberately unfinished utterances to survive a 1.5-second pause, and an end-of-turn delay no greater than two seconds. These are project targets, not vendor promises or reasons to remove the feature.

The M6 run on 21 October used 20 completed and 20 interrupted synthetic utterances per covered language (20 languages), 33 real EN/RU recordings, and 14 natural conversational turns. No synthetic language met both percentage targets. English completed 20/20 promptly but held only 11/20 interrupted examples; Russian completed 18/20 and held 3/20. Synthetic fragments can acquire terminal TTS prosody, so these tests cannot establish natural conversational accuracy. Bengali, Marathi and Norwegian had no matching fixtures in that run.

The natural examples show an actual benefit: ordinary silence detection split 13 of 14 turns internally; Smart Turn prevented ten of those splits. Three persisted (Indonesian, Italian, Portuguese). Seven examples finalized about 2.1–2.3 seconds after speech ended. The two-second limit currently bounds the semantic silence hold, not all downstream VAD/transcription/delivery time. This explains why it is not a guaranteed two-second final-response bound.

## How to use it

1. The server needs `STT_RUNTIME=selected` and `STT_SMART_TURN_MODEL` pointing to the pinned v3.2 checkpoint, with the ANE VAD active.
2. Request `smartTurn: true` in the agents provider, or `smart_turn: true` in raw STT config. Language routes: ar, bn, zh, da, nl, de, en, fi, fr, hi, id, it, ja, ko, mr, no, pl, pt, ru, es, tr, uk, vi.
3. Inspect each `stt_ready` event (raw stream: `ready`). `active` confirms the hook, `acoustic_fallback` reports ordinary silence detection, and missing status is unconfirmed. An unavailable model produces a config error. This signal confirms integration, not model accuracy.
4. Monitor both premature splits and final-response delay in the intended conversations. Setting `smartTurn: false` for a new stream restores acoustic endpointing. Defaults remain unchanged.

## Work remaining for default enablement

Use natural conversational development and held-out recordings with annotated pauses and end times. Diagnose classifier decisions, VAD batching and transcription delay separately. Test any threshold/hold change on held-out recordings, including quiet/noisy speech, before changing defaults. The already-measured 14 turns are regression cases, not a fresh holdout. No threshold, model or server configuration was changed by the SDK release.

Workspace evidence: `reports/phase1-qualification-2026-10-21/tables.md` (Smart turn and Natural EoT tables), `reports/phase1-qualification-2026-10-21/raw/qualification.json`, and `reports/preroll-followup-2026-10-20/README.md`. Historical watermark/listening gates in those reports were later withdrawn and are unrelated to Smart Turn acceptance.
