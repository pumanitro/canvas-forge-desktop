// Built-in STYLE GUIDES: a named art direction = reference art + the rules for applying it.
// Pick one in the prompt popover and hit Restyle — no prompt typing required.
//
// The reference images are the payload, not the prose. The art direction these came from
// (atlas-of-doors) proved this the hard way across 71 restyle variants and wrote the rule
// down as "You do not describe the style. You re-send it." Their evidence: two hand-written
// prose descriptions of Stone, months apart, DISAGREE with the pixel-sampled truth ("tan
// sandstone" vs the measured warm greige #746B5A). An attached image can't drift like that.
// So `description` and `ramp` below are for the HUMAN preview; the model gets refs + the
// invariants + a scoping clause, and never a style adjective.
//
// Bundled with ?inline → base64 data URLs at build time. That matters: the packaged app
// loads the renderer over file://, where fetch() is blocked, so a runtime fetch of an asset
// URL would work in dev and die in production.
import stoneFrame from './stone/stone-gold-frame-source.png?inline'
import stoneButton from './stone/stone-button.png?inline'
import stonePathpick from './stone/style-pathpick.png?inline'
import stoneTablet from './stone/stone-tablet.png?inline'
import goldChevron from './stone/gold-chevron-band.png?inline'
import goldKnotwork from './stone/gold-dark-knotwork.png?inline'

/** One selectable material within a guide. Turn them on/off to scope what the restyle uses. */
export type Material = {
  id: string
  name: string
  blurb: string
  description: string
  /** The guide's own pixel-sampled tonal ramp, [hex, role]. Preview only — never sent. */
  ramp: [string, string][]
}

export type GuideRef = {
  src: string
  label: string
  why: string
  /**
   * Which materials this ref actually SHOWS. A ref is attached only when EVERY material it
   * shows is selected — otherwise it smuggles an excluded material in through the back door.
   * That ordering matters more than extra negative prose: the art direction's own logs record
   * a case where the fix for stray pillars was deleting the ref that supplied them, not
   * telling the model harder not to draw pillars.
   */
  materials: string[]
}

export type StyleGuide = {
  id: string
  name: string
  /** One line, shown in the picker. */
  blurb: string
  /** The shared art direction — true whichever materials you pick. Humans only. */
  description: string
  /** Selectable materials, in application order (body first, then what's inlaid on it). */
  materials: Material[]
  /** Reference art, ordered by authority — the first 3 that qualify get attached. */
  refs: GuideRef[]
  /** Anti-hijack clause naming THIS guide's refs' own contaminants. Always sent. */
  guard: string
  /** Extra scoping prose for a partial material pick. Null when the refs already say it. */
  scope: (selected: string[]) => string | null
}

export const STYLE_GUIDES: StyleGuide[] = [
  {
    id: 'stone',
    name: 'Stone & Gold',
    blurb: 'Carved greige granite with inlaid gold line-work — stylized fantasy game UI.',
    description: [
      'Lighting model (the one rule that carries the whole look): key light from above — top edges catch a pale highlight, flat faces sit at the mid-tone, and carved grooves and lower edges fall into warm shadow. Replicate that gradient on every surface.',
      'Render style: stylized fantasy game-UI art — painterly "stylized 3D" RPG ornament (Hearthstone / Diablo / MTG Arena), soft baked light, gentle ambient occlusion, matte hand-painted finish. Not photoreal: no studio photography, lens blur or scanned-rock realism.',
      "The gold comes in two finishes on the same forms. The guide's own advice is to pick ONE per surface — the source frame uses polished on the ring and antiqued on the side bands."
    ].join('\n\n'),
    materials: [
      {
        id: 'stone',
        name: 'Stone body',
        blurb: 'Warm greige granite — matte, lightly pitted, eroded bevels.',
        description:
          'Warm desaturated greige granite (hue ≈ 38°, saturation 12–16%). Base tone #746B5A — taupe-grey with a faint brown undertone, NOT cool grey. Matte, micro-grain, light pitting, no specular. A tonal material: the same hue family shifted lighter on lit edges and darker in grooves.',
        ramp: [
          ['#232320', 'cavity'],
          ['#3A322A', 'deep shadow'],
          ['#463E33', 'groove'],
          ['#54493A', 'mid-shadow'],
          ['#645A4B', 'mid-dark'],
          ['#746B5A', 'BASE'],
          ['#857B68', 'lit face'],
          ['#958A77', 'highlight'],
          ['#A8A08C', 'catch-light'],
          ['#C0B7A2', 'rim']
        ]
      },
      {
        id: 'gold-polished',
        name: 'Polished gold · Variant A',
        blurb: 'Bright convex metal, mirror sheen, white-gold hotspot.',
        description:
          'The bright finish — a thin convex raised line in an embossed channel, bright and directional. It needs the full range in one stroke: bronze core, gold body, white-gold hotspot. Lit edge pale-gold ramping to bronze on the shadow side. This is the inner ring torus on the source frame.',
        ramp: [
          ['#2A2000', 'shadow'],
          ['#3D2F1E', 'bronze'],
          ['#664A30', 'deep'],
          ['#9A7634', 'mid'],
          ['#C39E59', 'body'],
          ['#E3C873', 'light'],
          ['#EAD987', 'highlight'],
          ['#FFE9B0', 'specular']
        ]
      },
      {
        id: 'gold-antiqued',
        name: 'Antiqued gold · Variant B',
        blurb: 'Muted aged old-gold, matte, no white specular.',
        description:
          "The aged finish — a muted old-gold, lighter and more golden than dark bronze, but it tops out at a soft antique gold (#D0BB7A) with NO white-gold specular and is much more matte than Variant A. Muted olive-bronze, sunk in a deep recessed channel, restrained sheen — worn, ancient gilding. These are the engraved marks on the frame's side bands.",
        ramp: [
          ['#463C20', 'recess'],
          ['#574A26', 'deep'],
          ['#67572A', 'shadow'],
          ['#776737', 'mid-dark'],
          ['#8A7538', 'body'],
          ['#A08A40', 'lit'],
          ['#BAA463', 'highlight'],
          ['#D0BB7A', 'top hi']
        ]
      }
    ],
    // Ordered by authority. With every material selected this yields the trio the source repo's
    // own logs blessed as its winning restyle stack (frame + button + path-pick).
    refs: [
      {
        src: stoneFrame,
        label: 'Stone ring frame',
        why: 'The material authority — every hex in this guide was pixel-sampled from it, and it is the only single image carrying stone, polished gold and antiqued gold at once under the canonical top-lit gradient.',
        materials: ['stone', 'gold-polished', 'gold-antiqued']
      },
      {
        src: stoneButton,
        label: 'Stone button',
        why: 'The direction applied to actual UI furniture — a carved plaque with a bevelled rim and gold lettering. Teaches what a button looks like in this style.',
        materials: ['stone', 'gold-polished']
      },
      {
        src: stonePathpick,
        label: 'Path-pick screen',
        why: 'A full UI screen in the direction — stone plaques in bevelled frames, carved title, torchlit backdrop.',
        materials: ['stone', 'gold-polished']
      },
      {
        src: goldChevron,
        label: 'Gold chevron band',
        why: 'The cleanest polished-gold specimen — a bevelled stone bar with a gold chevron band inlaid. UI-shaped, so there is no strong silhouette to hijack.',
        materials: ['stone', 'gold-polished']
      },
      {
        src: goldKnotwork,
        label: 'Antiqued knotwork',
        why: 'The clearest Variant-B specimen — antiqued gold knotwork sunk into stone.',
        materials: ['stone', 'gold-antiqued']
      },
      {
        src: stoneTablet,
        label: 'Bare stone tablet',
        why: 'Pure stone with a recessed inner field and no gold at all — the only ref that is safe when gold is switched off entirely.',
        materials: ['stone']
      }
    ],
    guard:
      'Use the reference art ONLY as a colour / material / lighting reference. Do NOT reproduce any ring, circular frame, red panel, health arc, "i" button, path bars, torches, purple or red accent lighting, scenery or backdrop from them, and do NOT copy their layout or composition. Take only their materials, finish and light.',
    scope: (sel) => {
      const out: string[] = []
      const A = sel.includes('gold-polished')
      const B = sel.includes('gold-antiqued')
      if (!sel.includes('stone'))
        out.push('Do not leave bare stone surfaces — the metal finish should carry the piece.')
      if (!A && !B)
        out.push(
          'Render every surface as bare stone: no gold, gilding, brass, bronze or metal line-work anywhere.'
        )
      else if (A && !B)
        out.push(
          'Any gold must be the bright polished finish — mirror sheen with a white-gold hotspot. Do not use darkened, aged or antiqued gold.'
        )
      else if (!A && B)
        out.push(
          'Any gold must be the darkened antiqued finish — muted and matte, sunk in a recessed channel. Do not use bright, mirror-sheen or white-hot polished gold.'
        )
      return out.length ? out.join(' ') : null
    }
  }
]

/**
 * The reference art actually attached for a given material selection: only refs whose every
 * shown material is selected, capped at 3 (base + 3 = the model's 4-image budget). Falls back
 * to the authority ref if a selection excludes everything, so a restyle is never ref-less.
 */
export function refsFor(g: StyleGuide, selected: string[]): GuideRef[] {
  const ok = g.refs.filter((r) => r.materials.every((m) => selected.includes(m)))
  return (ok.length ? ok : [g.refs[0]]).slice(0, 3)
}

/**
 * The exact text sent to the model. Deliberately contains NO style adjectives: the look comes
 * from the attached refs (see the note at the top of this file). What the prompt carries is the
 * invariants — keep the layout, keep the text, keep the aspect — the guide's guard, and a
 * scoping clause for a partial material pick. Shown verbatim in the preview: no hidden magic.
 */
export function buildRestylePrompt(g: StyleGuide, selected: string[], extra?: string): string {
  const refs = refsFor(g, selected)
  const lines = [
    'You are restyling one piece of interface artwork. Several images are attached.',
    'The FIRST attached image is the artwork to restyle. Keep its exact layout, every interface element, and all text labels and numbers in place and legible. This is a re-rendering of that artwork — not a new scene.',
    `The REMAINING ${refs.length} image(s) are STYLE REFERENCE ART, letterboxed on dark padding (ignore the padding). Use them as the ONLY basis for the visual style: match their materials, surface texture, colour, lighting, edge and line treatment, and overall finish. Do not invent a style of your own — derive it entirely from these references.`,
    g.guard
  ]
  const scope = g.scope(selected)
  if (scope) lines.push(scope)
  lines.push(
    'Constraints: preserve the composition and every interface element exactly; do not add scenery, doorways, portals or characters; do not move or relabel anything; keep every icon, number and label crisp and readable.'
  )
  if (extra?.trim())
    lines.push(`Additional instruction, applied on top of the restyle: "${extra.trim()}".`)
  lines.push(
    'Return ONE fully opaque image at the SAME width-to-height aspect ratio as the first image — never change its orientation. Paint every pixel: no transparency, no empty areas, no checkerboard.'
  )
  return lines.join('\n')
}
