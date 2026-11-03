# Lesson list: lessons in progress first, Start here, and hardening

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

## Validation

| Check | Result |
| --- | --- |
| Client suite | 738 passed. That includes 22 new tests in `client/tests/lessonListOrder.test.js`, covering ordering, page grouping, the Other-lessons rule, Start here, the cache accessor, and the page wiring. It also includes 7 in `client/tests/lessons-list-hardening.test.js`. |
| Browser suites (Chromium, local) | All passed: 3 in the new `npm --prefix client run test:browser:lessons` (paging focus, the card ring, Start here); 27 in the learner suite, after updating its course-progress test; and 24 in the admin suite, the one CI runs. |
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

## Not in this change

The same critique's other items are queued as separate passes:

- **Colorize:**
  - A visible light-mode course track.
  - The track also disappears in forced colors, which drop its fills. Only its count remains.
- **Polish:**
  - Top-align card titles, which still drop beside a wrapped neighbor. Start here doesn't change that: the first title in the fixture wrapped before it too.
  - Move the outline's course label out from above its title.

The harden pass also found these, outside this page:

- **Right-to-left text on the lesson page.** The conversation and its outline don't set text direction either.
- **Shared card outline.** The shared `Card` loses its outline in forced colors everywhere else, such as administration and settings. The fix here is scoped to lesson cards.
- **Repeated progress reads.** After every tab refocus, `sync.loadAll()` clears the cache. The list's confirming read then makes one request per unstarted lesson, in sequence. It is cheap, but it grows with the catalog. `/impeccable optimize` could skip it when the bulk load succeeded.
