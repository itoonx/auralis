// Inline 24-unit stroke icons shaped after the studio's lucide set — the site
// ships no icon library, so the mock carries its own paths. Rendered with
// fill="none" stroke="currentColor" stroke-width="2" round caps.
export const ICON: Record<string, string> = {
  logo: '<path d="M2 12h4l3-8 4 16 3-8h4"/>',
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  graph:
    '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M10.9 7.2 6.1 16.7M13.1 7.2l4.8 9.5M7.5 19h9"/>',
  decisions:
    '<path d="m3 6 1.6 1.6L7.4 4.9M3 12l1.6 1.6 2.8-2.7M3 18l1.6 1.6 2.8-2.7"/><path d="M11 6h10M11 12h10M11 18h10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  // event-kind glyphs (KindChip vocabulary)
  phase: '<path d="M12 13v8M12 3v3"/><path d="M5 6h12l2.5 3.5L17 13H5z"/>',
  task: '<path d="m7 4 13 8-13 8z"/>',
  tool: '<path d="m7 6 6 6-6 6M13 6l6 6-6 6"/>',
  finding: '<path d="m4 12.5 5.5 5.5L20 7"/>',
  overlap: '<path d="M12 3 2.5 20h19zM12 9.5V14M12 16.8v.4"/>',
}
