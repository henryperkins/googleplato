# Lesson list: lessons in progress first, Start here, hardening, and progress colors

A 2026-11-03 design critique of `/lessons` found that the screen didn't answer "what next?". Lessons sorted alphabetically by course. A returning learner's 20% lesson sat on page 2, behind a 14-lesson course. The outline dialog, the one place a learner decides, ended in a lone Close.

The owner chose the smallest structural fix: keep one grid and the existing cards, and re-sort it.

- **Ordering.** While every status is shown, lessons the learner has started and not completed lead the whole list under an **In progress** heading. They stay in catalog order among themselves, then the course groups follow. A status filter keeps the plain course grouping.
- **Status chip.** The in-progress chip shows its percentage beside the ring, because 20% and 60% look alike as 22 px rings. The 12 px semibold number holds 4.52:1 on the amber wash in light mode and 7.73:1 in dark.
- **Lessons without a course.** They come last under **Other lessons** whenever the list has other groups. Before, on page 2, "Run a five-minute retro" read as part of the course above it.
- **Outline dialog.** It ends with the lesson's next step beside Close: **Start lesson**, **Continue lesson**, or **Open lesson** once completed. It closes before navigating, so its background scroll lock (on iOS, a fixed `<body>`) is released before the lesson page renders.
- **First render.** It takes progress from the sync cache (`getCachedLessonKB()`), so the order is settled before cards appear. The existing per-lesson read still confirms it. That read is sequential, and every lesson not yet started is a network miss. Waiting for it would have shown "Loading lessons…" for one round trip per lesson; ignoring it would have moved the cards after they appeared.

## Start here for a learner with nothing started

The critique also found that a first-run learner lands on 14 identical empty circles, with nothing saying where to begin. The owner's scope called for **Start here** on the first lesson, inside the same grid.

- **The mark.** For a learner who hasn't started any lesson, the first lesson in the list shows **Start here** in place of its empty circle. It is a 24 px pill in the classroom's action fill, the one filled mark on the page. White text holds 9.3:1 on the default maroon and 5.6:1 on its lifted night fill.
- **Rules.**
  - It follows the filters, so a course filter suggests that course's first lesson.
  - It doesn't appear in a list of one lesson, and it never marks an admin's own `custom-*` lesson.
  - It leaves as soon as any lesson has a status, including one the filter hides.
  - Catalog order has no authored sequence, so an admin who wants a particular first lesson numbers the names.
- **Accessible name.** The open action's name ends with "Start here." It is the first Tab stop after the filters.
- **No flash.** It reads the same cached progress that orders the list, so a returning learner never sees it.

No explanatory copy was added. The lesson itself, one click away, shows that it is a conversation with a coach. A line saying so would be a new product claim, which is the owner's call.

## Hardening

A harden pass tested the page with keyboard paging, Windows high contrast (forced colors), and right-to-left and unbroken text. It also checked 200% zoom, doubled text size, and 320 px. Six problems turned up, and all are fixed:

- **Paging lost focus.** Pressing Next with the keyboard to reach the last page disables Next, so focus fell to the document. The next Tab reached the footer's Privacy link.
  - Previous and Next now move focus to the page heading, which brings the top of the new page into view.
  - Both stay focusable while disabled. Pressing a disabled one keeps focus where it is.
  - Clicking them with a mouse also scrolls to the top, without showing a focus ring.
  - Steps count from the page shown. When a reload shrank the list, Previous used to need extra presses before the page changed.
- **The card clipped its own focus ring.** The card clips to its rounded corners, so the open action's ring showed only as a line under the description.
  - While the open action has focus, the whole card now takes the ring, as it takes the hover shadow.
  - View outline keeps its own ring.
  - Browsers without `:has()` keep the button's own ring.
- **Right-to-left text read out of order.** In an Arabic lesson, a sentence containing the word "Slack" showed its parts in reverse order, its final period sat at the wrong end, and the title aligned left.
  - Titles, descriptions, course names, and the outline's author text now take their direction from their own text (`dir="auto"`).
  - The card's metadata isolates the course name, so the separators stay put.
  - Objective bullets move to the starting side.
- **High contrast dropped the card edges.** Forced colors remove shadows and fills, so cards lost their edges and Start here lost its pill. Both now keep a 1 px outline there.
- **Long words overflowed.** A long URL in a card description was cut off mid-line instead of ending in an ellipsis, and a long unbroken title ran into the outline's padding at 390 px.
  - Both now wrap.
  - The outline's title also gets 1.375 line spacing, since lesson names run to four lines on a phone.
- **A browser test predated the new order.** The learner suite's course-progress test expected the course's progress bar on page 1. That learner has 13 lessons in progress, which now fill page 1, so the test starts from page 2.

Some checks passed without changes:

- 200% zoom (640 px wide).
- Doubled default text size.
- No horizontal overflow at 320 or 390 px.
- A Chinese title with an emoji.
- Losing the network mid-session. A refresh keeps the loaded lessons and shows Try again, paging still works, and Try again recovers once the connection returns.

## Progress colors

The critique also found progress under-signalled in light mode. A colorize pass fixed the two bars on this page, the course summaries and the outline's:

- **A track that shows.**
  - The course bar's track used `--muted`, the same lightness as the workspace behind it (1.00:1). One of 14 read as a short maroon underline, and 0 of 14 showed no bar at all.
  - A new `--track` token is a step darker: 1.32:1 on the workspace and 1.44:1 on the outline's white, where `--muted` stood 1.09:1.
  - At night it is 14% white, a step above the borders. It rises 1.43:1 off the page and 1.55:1 off a dialog, where `--muted` stood 1.11:1.
- **Fills still read on it.**
  - Across the 223 classroom colors the contrast tests sweep, every progress fill holds at least 3.48:1 on the day track and 3.72:1 on the night track. The completed green holds at least 6.29:1.
  - The track is neutral, like the borders. The brand stays in the fill, and a green or amber classroom's track can't be mistaken for a status.
- **Green when complete.**
  - The outline drew a completed lesson's bar in the brand color while its card showed a green check. Its bar and its **Completed** label are now green, as on the lesson page.
  - A course's bar also turns green once every lesson it counts is complete.
- **High contrast.** Forced colors drop background fills, so both bars vanished and only the count remained. The track now keeps a 1 px outline, and the fill takes the text color.

## Validation

| Check | Result |
| --- | --- |
| Client suite | 740 passed. That includes 22 new tests in `client/tests/lessonListOrder.test.js`, covering ordering, page grouping, the Other-lessons rule, Start here, the cache accessor, and the page wiring. It also includes 8 in `client/tests/lessons-list-hardening.test.js`. The track's contrast in both themes, swept across classroom colors, is in `design-tokens-contract.test.js` and `branding.test.js`. |
| Browser suites (Chromium, local) | All passed: 4 in the new `npm --prefix client run test:browser:lessons` (paging focus, the card ring, Start here, and the progress bars' colors in both themes and in forced colors); 27 in the learner suite, after updating its course-progress test; and 24 in the admin suite, the one CI runs. The progress-color test fails against the build from before the colorize pass. |
| Lint | Passed: 0 errors, 19 existing client warnings. |
| Client build | Passed; existing bundle-size advisory. |
| Design detector | `detect --scope layout` and the full rule set found nothing on `LessonsList.jsx`. On `index.css` it repeats findings about older rules elsewhere in the file. |
| Browser check (Chromium, local learner fixture) | See below. |

The browser check covered:

- **Returning learner.** Both lessons in progress lead page 1, including the one that was on page 2. Tab from the Status filter reaches the first lesson in progress.
- **New learner.**
  - No In progress group appears.
  - Exactly one **Start here**, on the first lesson. Tab from the Status filter reaches it, named "Open lesson … Not started. Start here."
  - None on page 2, under the Completed filter, or in the one-lesson Uncategorized filter.
  - The Writing for Slack filter moves it to that course's first lesson. Its outline ends with Start lesson.
- **No Start here for anyone else.** That covers the returning learner, the learner with 13 lessons in progress, and a learner whose only lesson is completed.
- **Learner with 13 lessons in progress.** The group continues on page 2 under its heading.
- **Other lessons.** The heading appears on page 2.
- **"In progress" status filter.** The list keeps course groups.
- **Outline footers.** They read Continue lesson, Start lesson, and Open lesson.
- **Continue lesson.** It reaches `/lessons/feedback` with the scroll lock released.
- **Layout.** No horizontal overflow at 320 and 390 px, and no page errors. At 320 px the Start here pill wraps under the description.
- **Progress colors.** Measured as painted, in builds from before and after the colorize pass:
  - The course track went from 1.00:1 to 1.32:1 on the workspace by day, and from 1.30:1 to 1.43:1 at night.
  - The outline's track went from 1.09:1 to 1.44:1 by day, and from 1.11:1 to 1.55:1 at night.
  - The maroon fill holds 6.45:1 on the day track and 3.75:1 on the night track inside a dialog.
  - A completed lesson's outline bar, and a finished course's bar, paint the completed green in both themes.
  - In forced colors, both tracks show a solid 1 px outline and both fills paint in the text color.

All browser records are synthetic. Server code is unchanged.

## Screenshots

- `screenshots/returning-1280-light-before.png` and `screenshots/returning-1280-light.png`: the returning learner's first page, before and after.
- `screenshots/returning-390-light.png` and `screenshots/returning-390-dark.png`: on a phone, both lessons in progress fit the first screen.
- `screenshots/outline-continue-1280.png` and `screenshots/outline-start-390.png`: the outline's next step on desktop and in the phone sheet, where the primary action sits above Close.
- `screenshots/page2-other-lessons-1280.png`: the In progress group continuing on page 2, then the courses, then Other lessons.
- `screenshots/first-run-1280-light-before.png` and `screenshots/first-run-1280-light.png`: a new learner's first page, before and after Start here. The fixture's first lesson is named "Completed communication practice"; this learner hasn't started it.
- `screenshots/first-run-390-light.png`, `screenshots/first-run-390-dark.png`, and `screenshots/first-run-320-light.png`: Start here in the first phone screen, in both themes, and wrapped under the description at 320 px.
- `screenshots/harden-card-focus-before.png` and `screenshots/harden-card-focus-after.png`: keyboard focus on a lesson card, as a clipped line and then as a ring around the card.
- `screenshots/harden-paging-focus-after.png`: after Next by keyboard, focus is on the page heading at the top of page 2.
- `screenshots/harden-forced-colors-before.png` and `screenshots/harden-forced-colors-after.png`: forced colors, without and with the card and Start here outlines.
- `screenshots/harden-rtl-outline-before.png` and `screenshots/harden-rtl-outline-after.png`: an Arabic lesson's outline, left-aligned and out of order, then right-aligned and in order.
- `screenshots/colorize-course-light-before.png` and `screenshots/colorize-course-light-after.png`: a returning learner's course bar at 1 of 14, as a short underline and then on its track.
- `screenshots/colorize-first-run-390-before.png` and `screenshots/colorize-first-run-390-after.png`: a new learner's course at 0 of 14 on a phone, with no bar and then an empty track.
- `screenshots/colorize-outline-in-progress-before.png` and `screenshots/colorize-outline-in-progress-after.png`: the outline's bar at 60%, its remaining length faint and then visible.
- `screenshots/colorize-outline-completed-before.png` and `screenshots/colorize-outline-completed-after.png`: a completed lesson's outline, in the brand color and then green.
- `screenshots/colorize-course-complete-light-before.png` and `screenshots/colorize-course-complete-light-after.png`: a finished course, in the brand color and then green.
- `screenshots/colorize-course-dark-after.png` and `screenshots/colorize-course-complete-dark-after.png`: the same bars at night.
- `screenshots/colorize-forced-colors-before.png` and `screenshots/colorize-forced-colors-after.png`: forced colors, with no bar and then an outlined track and its fill.

## Not in this change

The same critique's other items are queued as separate passes:

- **Polish:**
  - Top-align card titles, which still drop beside a wrapped neighbor. Start here doesn't change that: the first title in the fixture wrapped before it too.
  - Move the outline's course label out from above its title.

The harden and colorize passes also found these, outside this page:

- **Right-to-left text on the lesson page.** The conversation and its outline don't set text direction either.
- **Shared card outline.** The shared `Card` loses its outline in forced colors everywhere else, such as administration and settings. The fix here is scoped to lesson cards.
- **Other progress bars.** The lesson page's bar and the admin readiness meters still sit on `--muted`, at 1.09:1 on white by day. Moving each to `--track` is one class. The readiness fills hold at least 6:1 on it, and the lesson bar's fill holds 3:1 for every classroom, as the list's do.
- **Repeated progress reads.** After every tab refocus, `sync.loadAll()` clears the cache. The list's confirming read then makes one request per unstarted lesson, in sequence. It is cheap, but it grows with the catalog. `/impeccable optimize` could skip it when the bulk load succeeded.
