// The 14 UK major allergens (Natasha's Law / FIC). Shared by browser and server.
export const ALLERGENS = [['celery', 'Celery'], ['gluten', 'Gluten'], ['crustaceans', 'Crustaceans'], ['eggs', 'Eggs'], ['fish', 'Fish'], ['lupin', 'Lupin'],
  ['milk', 'Milk'], ['molluscs', 'Molluscs'], ['mustard', 'Mustard'], ['nuts', 'Tree nuts'], ['peanuts', 'Peanuts'], ['sesame', 'Sesame'], ['soya', 'Soya'], ['sulphites', 'Sulphites']];
const L = Object.fromEntries(ALLERGENS);
export const cleanAllergens = (a) => [...new Set(Array.isArray(a) ? a : [])].filter((k) => k in L);
export const allergenText = (a) => (a || []).map((k) => L[k]).filter(Boolean).join(', ');
// everything in the item plus the chosen customisations: sel = { groupIndex: [choiceIndex] }
export const itemAllergens = (it, sel = {}) => cleanAllergens([...(it.allergens || []), ...it.options.flatMap((g, gi) => (sel[gi] || []).flatMap((ci) => g.choices[ci]?.allergens || []))]);

// Dietary tags merchants can put on items (customers filter by them). Not legal claims – the café is responsible for accuracy.
export const DIETARY = [['vegetarian', 'Vegetarian'], ['vegan', 'Vegan'], ['gluten-free', 'Gluten-free'], ['dairy-free', 'Dairy-free'], ['halal', 'Halal']];
const D = Object.fromEntries(DIETARY);
export const cleanDietary = (a) => [...new Set(Array.isArray(a) ? a : [])].filter((k) => k in D);
