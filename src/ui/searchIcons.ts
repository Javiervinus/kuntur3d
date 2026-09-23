/**
 * Íconos del buscador (24×24, de trazo, en el color del texto): uno por tipo de resultado y uno
 * por grupo de categoría de los negocios (config/region.json → search.places.categories[].group).
 * Un grupo sin ícono usa el del pin.
 */
const PATHS: Record<string, string> = {
  landmark: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  area: '<path d="M4 7l5-3 6 3 5-3v13l-5 3-6-3-5 3z"/><path d="M9 4v13M15 7v13"/>',
  street: '<path d="M8 3L5 21M16 3l3 18"/><path d="M12 4.5v2.5M12 10.8v2.4M12 17v2.5"/>',
  crossing: '<path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/>',
  place: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  food: '<path d="M7 3v18M4.5 3v5a2.5 2.5 0 005 0V3"/><path d="M17.5 21V3c-2 1.4-3.5 4-3.5 7.5V14h3.5"/>',
  cafe: '<path d="M4.5 9h11v4.5a5 5 0 01-5 5h-1a5 5 0 01-5-5z"/><path d="M15.5 10.5h1.5a2.5 2.5 0 010 5h-1.5"/><path d="M8 3.5v2.5M11.5 3.5v2.5"/>',
  bar: '<path d="M5.5 4h13L12 12z"/><path d="M12 12v8M8 20h8"/>',
  shop: '<path d="M5 8h14l-1 12.5H6z"/><path d="M9 10V6.5a3 3 0 016 0V10"/>',
  mall: '<path d="M3 21h18M5 21V9l7-5 7 5v12"/><path d="M9.5 21v-5h5v5M9 11.5h6"/>',
  health: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  pharmacy: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
  money: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>',
  school: '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5v4.5c3 2.2 8 2.2 11 0v-4.5M21.5 9.5v5"/>',
  worship: '<path d="M12 2.5v4.5M10 4.5h4"/><path d="M6 21v-8.5l6-5 6 5V21z"/><path d="M10 21v-3.5a2 2 0 014 0V21"/>',
  hotel: '<path d="M3 18.5V6M3 14h18v4.5M21 14v-2.5a3 3 0 00-3-3h-7V14"/><circle cx="7" cy="11" r="2"/>',
  transport: '<rect x="5" y="3" width="14" height="14.5" rx="2.5"/><path d="M5 11h14M8 21v-3.5M16 21v-3.5"/><path d="M8.5 14.3v.01M15.5 14.3v.01"/>',
  fuel: '<path d="M4.5 21V5a2 2 0 012-2h6a2 2 0 012 2v16M3 21h13M4.5 10h10"/><path d="M14.5 8l3 3v5.5a1.5 1.5 0 003 0V9l-3-3"/>',
  car: '<path d="M4.5 16.5h15V13l-2-5h-11l-2 5z"/><path d="M4.5 13h15"/><circle cx="8" cy="16.5" r="1.8"/><circle cx="16" cy="16.5" r="1.8"/>',
  park: '<path d="M12 21v-6.5"/><path d="M12 3a5 5 0 00-4.6 7A4 4 0 009 17h6a4 4 0 001.6-7A5 5 0 0012 3z"/>',
  culture: '<path d="M3 9l9-5 9 5M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 21h18"/>',
  sport: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5l3.8 2.8-1.4 4.4H9.6l-1.4-4.4z"/><path d="M12 3.5v4M20.2 10.2l-4.4.1M3.8 10.2l4.4.1M7.6 19.3l2-4.6M16.4 19.3l-2-4.6"/>',
  gov: '<path d="M5 21V3.5M5 4h11.5l-2.2 3.8 2.2 3.7H5"/>',
  service: '<path d="M14.8 6.2a4 4 0 00-5.3 5.3L4 17l3 3 5.5-5.5a4 4 0 005.3-5.3l-2.6 2.6-2.4-.5-.5-2.4z"/>',
  beauty: '<circle cx="6.5" cy="7" r="2.5"/><circle cx="6.5" cy="17" r="2.5"/><path d="M8.6 8.5L20 17.5M8.6 15.5L20 6.5"/>',
  coords: '<circle cx="12" cy="12" r="7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.4"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  plusCode: '<path d="M9.5 4L7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  loading: '<path d="M12 3.5a8.5 8.5 0 018.5 8.5"/>',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Ícono como elemento SVG (los trazos son fijos: no llevan nada escrito por el usuario). */
export function searchIcon(key: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[key] ?? PATHS.place;
  return svg;
}
