# Fitness Tracker

An Obsidian plugin for logging workouts as notes, with a monthly consistency heatmap and per-exercise weight / reps / set stats.

## Install

1. In your vault, create the folder `.obsidian/plugins/fitness-tracker/`
2. Copy `main.js`, `manifest.json` and `styles.css` into it
3. Restart Obsidian (or reload with `Ctrl/Cmd+R`)
4. Settings → Community plugins → enable **Fitness Tracker**

No build step is needed — `main.js` is plain JavaScript that Obsidian loads directly. It works on mobile too.

## Using it

- **Log a workout** — the dumbbell icon in the ribbon, or the command `Fitness Tracker: Log workout`. Fill in the activity, optional bodyweight, then one row per exercise: weight, reps, and how many sets. Saving writes the sets out one row per set.
- **See the dashboard** — command `Fitness Tracker: Open fitness tracker` opens it in the right sidebar. Click a filled day to open that note; click an empty day to log it retroactively.
- **Embed it anywhere** — put a `fitness` code block in any note (see below). Handy if you keep a dashboard note.

## Data format

One note per day, at `Fitness/Logs/2026-09-16.md` by default:

```markdown
---
type: workout
date: 2026-09-16
activity: Push day
bodyweight: 72.5
---

# Push day — Wed 16 Sep 2026

## Sets

| Exercise | Set | Weight | Reps |
| --- | --- | --- | --- |
| Bench press | 1 | 60 | 8 |
| Bench press | 2 | 62.5 | 6 |
| Overhead press | 1 | 35 | 10 |

## Notes
```

Nothing is stored in a hidden database. You can edit the table by hand, and Dataview can query the frontmatter. Logging a second time on the same date appends rows to the existing table rather than creating a second note. Cardio with no load is fine — log the activity with no exercises and the day still counts toward the streak.

## Embedding

````markdown
```fitness
month: 2026-09
metric: volume
stats: true
limit: 6
```
````

| Option | Values | Default |
| --- | --- | --- |
| `month` | `YYYY-MM` | current month |
| `metric` | `volume`, `sets`, `done` | from settings |
| `summary` | `true`, `false` | true |
| `heatmap` | `true`, `false` | true |
| `stats` | `true`, `false` | true |
| `limit` | number of exercises | from settings |
| `title` | any text, or `false` | month name |

## Settings

Log folder, weight unit (kg/lb), what the heatmap shade means, week start day, accent colour, translucent vs flat panels, and how many exercises and how much history the stats table covers.

## Notes on styling

`styles.css` is written against Obsidian's own theme variables, so it picks up whatever theme the vault uses. The translucent panels are a single toggle in settings; turn it off for flat backgrounds.
