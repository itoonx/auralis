// One ordered list of the page's sections — the single source of truth for
// both the nav "more" dropdown (jump to any section) and the badge above each
// section header. A section's badge always matches its menu entry because
// both read from here. Order mirrors index.astro. Labels say what the section
// is about, not just a bare noun.
export interface SectionLink {
  id: string
  label: string
  // top-level nav items (install, architecture) keep their badge but drop out
  // of the "more" index so they aren't listed twice
  hideInMenu?: boolean
}

export const SECTIONS: SectionLink[] = [
  { id: 'studio', label: 'live dashboard' },
  { id: 'problem', label: 'the problem' },
  { id: 'bet', label: 'the thesis' },
  { id: 'proof', label: 'proven results' },
  { id: 'architecture', label: 'architecture', hideInMenu: true },
  { id: 'memory', label: 'shared memory' },
  { id: 'coordination', label: 'live coordination' },
  { id: 'build', label: 'build mode' },
  { id: 'replay', label: 'run replay' },
  { id: 'mcp', label: 'MCP' },
  { id: 'install', label: 'install', hideInMenu: true },
  { id: 'limits', label: 'roadmap' },
]

// what the nav "more" dropdown lists — the full index minus top-level dupes
export const MENU: SectionLink[] = SECTIONS.filter((s) => !s.hideInMenu)

export const sectionLabel = (id: string): string | undefined =>
  SECTIONS.find((s) => s.id === id)?.label
