<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into Photoshock. The project already had `posthog-js` installed and a `posthog-client.js` file with basic initialization and a generic `ui_click` event. This integration adds 10 meaningful business events covering the full user journey: loading splats, painting and baking, layer management, exporting, taking snapshots, and the support/contribution funnel.

| Event | Description | File |
|---|---|---|
| `splat_loaded` | User loads a Gaussian splat file (drag-and-drop or file picker) | `src/main.js` |
| `splat_exported` | User exports the painted splat to a PLY file | `src/main.js` |
| `layer_imported` | User imports a splat file as a new layer | `src/main.js` |
| `layer_added` | User adds a new empty layer | `src/main.js` |
| `layer_deleted` | User deletes a layer | `src/main.js` |
| `paint_baked` | User bakes GPU brush/bucket/erase paint into splat SH + opacity | `src/main.js` |
| `color_grade_baked` | User bakes the color grade settings into the active splat target | `src/main.js` |
| `viewport_snapshot_taken` | User downloads a viewport screenshot | `src/main.js` |
| `support_modal_opened` | Support/donation modal is shown to the user | `src/support-modal.js` |
| `contributor_marked` | User marks themselves as a contributor (Gumroad purchase or manual acknowledgement) | `src/support-modal.js` |

## Next steps

We've suggested some insights you can build in PostHog to keep an eye on user behavior, based on the events we just instrumented:

1. **Splat Load → Export funnel** — Track the conversion rate from `splat_loaded` to `splat_exported`. Users who export are your most engaged users.
   Create at: https://us.posthog.com/project/365865/insights/new#funnel

2. **Support conversion funnel** — Track `support_modal_opened` → `contributor_marked` to measure your donation conversion rate.
   Create at: https://us.posthog.com/project/365865/insights/new#funnel

3. **Export volume over time** — Trend of `splat_exported` events to understand how many files users are producing.
   Create at: https://us.posthog.com/project/365865/insights/new#trend

4. **Bake activity** — Trend of `paint_baked` and `color_grade_baked` to measure how many users reach the bake step (a strong engagement signal).
   Create at: https://us.posthog.com/project/365865/insights/new#trend

5. **Layer usage** — Trend of `layer_added` and `layer_imported` to understand multi-layer workflow adoption.
   Create at: https://us.posthog.com/project/365865/insights/new#trend

Create a dashboard to collect all of these: https://us.posthog.com/project/365865/dashboards/new

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
