---
name: humanizer
description:
  Rewrite AI-generated text to sound natural and human-written.
  Removes LLM tells — cliché phrases, predictable structure,
  inflated language, and robotic patterns.
metadata:
  {
    "cowork":
      {
        "emoji": "✍️",
        "category": "Creative",
      },
  }
---

# Humanizer ✍️

Rewrite AI-generated text so it reads like a real human wrote it. Eliminates every detectable sign of LLM output while preserving meaning, facts, and intent.

## Overview

AI-generated text has recognizable patterns that experienced readers (and detection tools) spot instantly. This skill systematically removes those patterns across 7 layers — from individual word choices up to document-level structure.

Unlike simple synonym swappers, this skill addresses the full stack of AI tells: vocabulary, sentence mechanics, paragraph structure, emotional register, content depth, and document architecture.

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | No | — | The text to humanize (or paste it directly in the message) |
| `tone` | select | No | `professional` | Target tone: `casual`, `professional`, `academic`, `journalistic`, `technical`, `warm` |

## Usage

Invoke the skill and provide the text to rewrite:

```
/humanizer
```

Then paste the text, or provide it with parameters:

- "Humanize this email draft"
- "Make this blog post sound less like AI"
- "Rewrite this in a casual tone"

## The 7 Layers of AI Tells

The skill targets every layer where AI writing diverges from human writing:

### Layer 1: Dead Giveaway Words

Words and phrases that LLMs use at far higher frequency than humans:

**Verbs:** delve, explore, navigate, leverage, utilize, foster, bolster, spearhead, underscore, streamline, facilitate, encompass, embark, unravel, illuminate, exemplify, revolutionize, catapult, skyrocket, supercharge

**Adjectives:** seamless(ly), robust, comprehensive, cutting-edge, groundbreaking, innovative, transformative, pivotal, paramount, intricate, nuanced, multifaceted, holistic, dynamic, vibrant, meticulously, strategically, notably

**Nouns:** landscape, realm, tapestry, beacon, cornerstone, linchpin, catalyst, paradigm, synergy, ecosystem, framework, trajectory, underpinning, bedrock, nexus, interplay, confluence

**Filler transitions:** Moreover, Furthermore, Additionally, It is worth noting that, Interestingly, Notably, Significantly, Indeed, In today's [X] landscape, In the realm of, When it comes to, All in all, In conclusion

**Hollow intensifiers:** a testament to, a beacon of hope, the power of, the beauty of, serves as a reminder, plays a crucial role, at the heart of, the very fabric of, the ever-evolving, sheds light on, paves the way for

### Layer 2: Structural Predictability

| AI Pattern | What Humans Do Instead |
|------------|----------------------|
| Identical paragraph template (topic → support → wrap) | Vary: some paragraphs are one sentence, some bury the point |
| Rule of Three ("innovation, collaboration, and excellence") | List two things, or four, or none |
| Mirrored section lengths | Uneven — a long deep-dive then a terse one-liner |
| Formulaic opening ("In today's rapidly evolving...") | Start with the point |
| Conclusion that restates everything | Add a new thought, or just end |
| Heading → Paragraph → Heading → Paragraph grid | Insert asides, questions, single emphatic sentences |

### Layer 3: Emotional Flatness

- **Compulsive both-sidesing**: "While X has challenges, it also presents opportunities." — Pick a side.
- **Hedge stacking**: "It could potentially be somewhat beneficial." — Say "it helps."
- **False enthusiasm**: "Exciting developments" / "truly inspiring" — Use sparingly and genuinely.
- **Emotional uniformity**: Every paragraph at the same temperature. Real writing has frustration, humor, bluntness.

### Layer 4: Sentence Mechanics

- **Excessive em dashes** — AI uses 3-5x more than humans
- **Colon-list combo** — "Three key factors: X, Y, and Z." Weave into prose instead.
- **Gerund openers** — "Leveraging AI, organizations can..." Start with subject-verb.
- **Passive voice overuse** — Say who did what
- **Identical sentence starts** — 3+ sentences starting with "This" / "The" / "It"
- **Uniform sentence length** — Mix short punchy with longer complex ones

### Layer 5: Content Tells

- **Saying nothing while sounding smart** — Confident sentences with zero information
- **Restating the question as an introduction** — Skip the throat-clearing
- **Superficial analysis** — Naming things without analyzing them
- **Fake specificity** — "various", "numerous", "a wide range of" instead of actual specifics
- **Promotional tone** — "game-changing", "next-level", "best-in-class"

### Layer 6: Document Structure

- **Five-paragraph essay** default
- **Every paragraph 3-5 sentences** — Real range: 1 to 10+
- **Perfect topic-sentence discipline** — Not every paragraph needs to announce its subject first
- **No tangents or asides** — Humans go on brief tangents and circle back
- **Bullet-point addiction** — Lists only when content genuinely calls for it

### Layer 7: Vocabulary & Register

- **Thesaurus syndrome** — Fancy synonyms to avoid repeating words. Humans just say "said" again.
- **Register mismatch** — Formal academic diction in casual contexts
- **No contractions** — Real writing uses "don't", "it's", "they're"
- **Overly precise hedging** — "approximately" → "about", "a significant number" → "a lot"

## Tone Options

| Tone | Characteristics |
|------|----------------|
| **casual** | Contractions, short sentences, conversational asides, informal vocab |
| **professional** | Clean and direct, no jargon for jargon's sake, confident but not stiff |
| **academic** | Precise language, longer sentences OK, hedging where scientifically appropriate |
| **journalistic** | Lead with the news, inverted pyramid, active voice, tight prose |
| **technical** | Exact terminology, no fluff, imperative mood for instructions |
| **warm** | First person, anecdotes welcome, emotional honesty, contractions |

## Rewriting Process

1. Read the full text — understand the core message
2. Strip AI scaffolding — filler transitions, hollow intensifiers, throat-clearing
3. Vary structure — break predictable templates, mix sentence/paragraph lengths
4. Replace flagged words — swap with plain, natural alternatives
5. Add human texture — asides, questions, opinions where appropriate
6. Cut the fat — AI text is typically 20-40% longer than needed
7. Read aloud — if it sounds like a press release, rewrite it

## What Gets Preserved

- All factual claims and data points
- Technical terminology that's correct and necessary
- The author's intended meaning and argument
- Proper nouns, quotes, and citations
- Genuinely good phrasing

## What the Skill Avoids

- Making text worse by forcing casual tone where formality fits
- Adding fake personal anecdotes
- Changing meaning or introducing inaccuracies
- Adding humor where inappropriate (legal, medical, etc.)
- Swapping AI clichés for different clichés

## Example

**Before (AI-generated):**
> In today's rapidly evolving digital landscape, leveraging innovative AI technologies has become paramount for organizations seeking to navigate the complexities of modern business. Moreover, these groundbreaking tools serve as a catalyst for transformative change, fostering seamless collaboration and driving robust growth across the ecosystem.

**After (humanized):**
> Companies that adopt AI tools tend to work faster and collaborate better. The ones getting real results aren't chasing trends — they're solving specific problems with the right tool for the job.

## Comparison with ClawHub Version

| Feature | ClawHub (biostartechnology) | CoWork OS |
|---------|---------------------------|-----------|
| AI patterns covered | 9 categories | 7 layers with 50+ specific patterns |
| Flagged word lists | Not included | 60+ verbs, adjectives, nouns, transitions, intensifiers |
| Structural analysis | Not detailed | Paragraph templates, section balance, document architecture |
| Sentence mechanics | Em dashes only | Em dashes, gerunds, passive voice, sentence starts, length variation |
| Content-level tells | Superficial analysis only | Empty claims, throat-clearing, fake specificity, promotional tone |
| Tone adaptation | Not available | 6 tone presets with characteristics |
| Rewriting process | Not documented | 7-step systematic process |
| Parameters | None | `text` (string) + `tone` (select with 6 options) |
