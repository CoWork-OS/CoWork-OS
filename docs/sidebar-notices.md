# Sidebar Notices

The left sidebar has one notification area, just above **Automated sessions**. Use it for
lightweight, dismissable notices: feature discovery, tips, or a prompt to finish setting
something up. Don't add one-off banners anywhere else in the sidebar.

- Component: `src/renderer/components/sidebar/SidebarNotices.tsx`
- Styles: `src/renderer/components/sidebar/sidebar-notices.css`

## Adding a notice

Append an entry to `SIDEBAR_NOTICES`:

```ts
{
  id: "my-feature-v1",            // stable and unique; never reuse an old id
  icon: Sparkles,                  // lucide-react icon
  label: "Try the new thing",      // short, one line
  onActivate: () => { /* open the feature */ },
  isVisible: () => true,           // optional runtime gate
}
```

## Behavior

- **Dismissable:** the X shows on hover. Dismissed ids are stored in localStorage under
  `cowork.sidebarNotices.dismissed`, and a dismissed notice never comes back. To show a
  notice again, give it a new id (for example `-v2`).
- **First-show animation:** a notice slides in and its icon pops only the first time it is
  ever shown. Seen ids are stored in `cowork.sidebarNotices.seen`. The animation is
  turned off when the system asks for reduced motion.
- **Order:** notices render in array order, so put the most important one first.

## Current notices

| id | What it does |
| --- | --- |
| `use-cases-gallery-v1` | Opens the "See how people use CoWork OS" gallery (`UseCasesGallery.tsx`) centered over the visible composer: the welcome screen or Build. Anywhere else it opens over the whole window. |
