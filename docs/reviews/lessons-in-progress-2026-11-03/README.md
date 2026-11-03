# Lesson list: lessons in progress first, and Start here

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

## Validation

| Check | Result |
| --- | --- |
| Client suite | 731 passed, including 22 new tests in `client/tests/lessonListOrder.test.js`: ordering, page grouping, the Other-lessons rule, Start here, the cache accessor, and the page wiring. |
| Lint | Passed: 0 errors, 19 existing client warnings. |
| Client build | Passed; existing bundle-size advisory. |
| Design detector | `detect --scope layout` and the full rule set: no findings on `LessonsList.jsx`. |
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

## Not in this change

The same critique's other items are queued as separate passes:

- **Harden:**
  - Keep focus and position when paging.
  - The card's `overflow-hidden` clips the open action's focus ring on three sides, so keyboard focus shows as one line under the description. Found during this pass.
- **Colorize:** a visible light-mode course track.
- **Polish:**
  - Top-align card titles, which still drop beside a wrapped neighbor. Start here doesn't change that: the first title in the fixture wrapped before it too.
  - Move the outline's course label out from above its title.
