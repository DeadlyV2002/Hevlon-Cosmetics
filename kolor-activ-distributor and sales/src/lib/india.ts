// States and union territories, so "UP", "U.P." and "Uttar Pradesh" end up as one state.
import { normName } from "./parse";

export const STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
  "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana",
  "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
];

const OTHER_NAMES: Record<string, string[]> = {
  "Andhra Pradesh": ["ap"], "Arunachal Pradesh": ["ar"], "Assam": ["as"], "Bihar": ["br"],
  "Chhattisgarh": ["cg", "ct", "chattisgarh", "chhatisgarh"], "Goa": ["ga"], "Gujarat": ["gj", "gujrat"],
  "Haryana": ["hr"], "Himachal Pradesh": ["hp"], "Jharkhand": ["jh"], "Karnataka": ["ka", "kn"], "Kerala": ["kl"],
  "Madhya Pradesh": ["mp"], "Maharashtra": ["mh"], "Manipur": ["mn"], "Meghalaya": ["ml"], "Mizoram": ["mz"],
  "Nagaland": ["nl"], "Odisha": ["od", "or", "orissa"], "Punjab": ["pb"], "Rajasthan": ["rj"], "Sikkim": ["sk"],
  "Tamil Nadu": ["tn"], "Telangana": ["ts", "tg"], "Tripura": ["tr"], "Uttar Pradesh": ["up"],
  "Uttarakhand": ["uk", "ua", "uttaranchal"], "West Bengal": ["wb"], "Andaman and Nicobar Islands": ["an", "andaman", "andaman nicobar"],
  "Chandigarh": ["ch"], "Dadra and Nagar Haveli and Daman and Diu": ["dn", "dd", "dnh", "daman", "daman and diu", "dadra and nagar haveli"],
  "Delhi": ["dl", "new delhi", "nct of delhi", "delhi ncr", "ncr"], "Jammu and Kashmir": ["jk", "j k", "jammu kashmir", "j and k"],
  "Ladakh": ["la"], "Lakshadweep": ["ld"], "Puducherry": ["py", "pondicherry", "pondy"],
};

// Every name is also stored without spaces, so "Tamilnadu", "U.P." and "J & K" match too.
const LOOKUP = new Map<string, string>();
const put = (key: string, s: string) => { LOOKUP.set(normName(key), s); LOOKUP.set(normName(key).replace(/ /g, ""), s); };
for (const s of STATES) {
  put(s, s);
  put(s.replace(/ and /g, " "), s);
  for (const o of OTHER_NAMES[s] || []) put(o, s);
}

/** "U.P." → "Uttar Pradesh". Unknown text comes back trimmed, so nothing typed is lost. */
export function normalizeState(s: string | null | undefined): string {
  const t = String(s ?? "").trim();
  if (!t) return "";
  const n = normName(t.replace(/&/g, " and "));
  return LOOKUP.get(n) || LOOKUP.get(n.replace(/ /g, "")) || t;
}
