import type { OrderType } from './orders.dto';

export type CatalogEntry = {
  /** LOINC code. */
  code: string;
  display: string;
  type: OrderType;
};

/**
 * Starter set of common LOINC order codes for the order form's search box.
 * Any other LOINC code can still be entered by hand; this list is a
 * convenience, not an allow-list. A real deployment would load the lab's own
 * test catalogue instead.
 */
export const ORDER_CATALOG: readonly CatalogEntry[] = [
  {
    code: '58410-2',
    display: 'CBC panel - Blood by Automated count',
    type: 'LAB',
  },
  { code: '718-7', display: 'Hemoglobin [Mass/volume] in Blood', type: 'LAB' },
  { code: '6690-2', display: 'Leukocytes [#/volume] in Blood', type: 'LAB' },
  { code: '777-3', display: 'Platelets [#/volume] in Blood', type: 'LAB' },
  { code: '24323-8', display: 'Comprehensive metabolic panel', type: 'LAB' },
  {
    code: '2345-7',
    display: 'Glucose [Mass/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '4548-4',
    display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
    type: 'LAB',
  },
  {
    code: '2160-0',
    display: 'Creatinine [Mass/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '3094-0',
    display: 'Urea nitrogen [Mass/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '2951-2',
    display: 'Sodium [Moles/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '2823-3',
    display: 'Potassium [Moles/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '1920-8',
    display:
      'Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '1742-6',
    display:
      'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '24331-1',
    display: 'Lipid 1996 panel - Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '3016-3',
    display: 'Thyrotropin [Units/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '6598-7',
    display: 'Troponin T.cardiac [Mass/volume] in Serum or Plasma',
    type: 'LAB',
  },
  {
    code: '1988-5',
    display: 'C reactive protein [Mass/volume] in Serum or Plasma',
    type: 'LAB',
  },
  { code: '5902-2', display: 'Prothrombin time (PT)', type: 'LAB' },
  {
    code: '24357-6',
    display: 'Urinalysis macro (dipstick) panel - Urine',
    type: 'LAB',
  },
  {
    code: '600-7',
    display: 'Bacteria identified in Blood by Culture',
    type: 'LAB',
  },
  { code: '36643-5', display: 'XR Chest 2 Views', type: 'RAD' },
  { code: '24627-2', display: 'CT Chest', type: 'RAD' },
  { code: '24725-4', display: 'CT Head', type: 'RAD' },
  { code: '24558-9', display: 'US Abdomen', type: 'RAD' },
];

export function searchCatalog(
  type: OrderType | undefined,
  text: string | undefined,
): CatalogEntry[] {
  const needle = text?.trim().toLowerCase();
  return ORDER_CATALOG.filter(
    (entry) =>
      (!type || entry.type === type) &&
      (!needle ||
        entry.code.includes(needle) ||
        entry.display.toLowerCase().includes(needle)),
  );
}

export function catalogEntry(code: string): CatalogEntry | undefined {
  return ORDER_CATALOG.find((entry) => entry.code === code);
}
