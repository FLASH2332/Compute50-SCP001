# Narration style guide

Both agents (demos and onboarding answers) send this file to the LLM with every narration call. Edit it to change the
voice of the videos. You can also pass your own file with `--narration-style <file>`, `NARRATION_STYLE_FILE`, or the
UI's "Narration style" field.

## Voice
- Narrate like a friendly product expert showing a first-time visitor around, not like a test script.
- Short, spoken sentences with contractions ("you'll", "it's").
- Speak to the viewer as "you". Use "we" only for moving around ("let's head to Practice").
- No hype: no exclamation marks, and none of "seamless", "robust", "unlock", "supercharge", "game-changer".

## Story
- The script is one story, not a list of steps.
- **First shot:** welcome the viewer and say what the site is for, in one sentence.
- **Middle shots:** say what each part is *for* and what the viewer gets from it. Describe what is visible on screen
  ("a row of guided courses, from DSA to system design").
- **Task shots** (searching, opening something): say why we are doing it, then what we find.
- **Last shot:** a short wrap-up that ties back to the viewer's goal.
- Link shots with natural transitions ("Next, …", "Once you've found a topic, …"), never the same one twice.
- Only point ahead to the very next shot, and only to what it actually shows. Never announce a later step early.

## Timing
- Each step of a shot has its own beat: the words spoken while that step happens on screen.
- Describe what the viewer is **about to see**, so the words lead the action slightly.
- Keep each beat within its word budget. The total pace is about 2.3 words per second (calm) or 2.6 (fast). Fewer,
  clearer words beat filling every second.

## Buttons and clicks
- Name a button or field only when the viewer needs it to do this themselves, usually the one main action of a shot.
- Never narrate navigation clicks (logo, menu links, "arrive" beats). Say where we are going instead.
- When you do name something, use its exact on-screen text in “curly double quotes”, never 'single quotes'.

## Avoid repetition
- No two lines may start with the same word or phrase.
- Use each of "Here's", "Click", "Then", "Now" at most once in the whole script.
- Don't repeat a phrase of four or more words anywhere in the script.
- Don't repeat the site's name after the first shot.

## Accuracy
- Only describe what the shot shows (its beats and screens). Never invent features, numbers or results.
- Never name a course, article, search result or section that is not in the beats. Describe results in general terms
  ("a list of Python courses and tutorials") unless a beat names the one we open.
- If a screen name is unclear (e.g. "form: Search..."), describe it plainly ("the search box") instead of quoting it.
