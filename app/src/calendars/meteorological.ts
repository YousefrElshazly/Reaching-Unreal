import type { Calendar } from "./types";
import {
  labelForWeekStart as metLabel,
  seasonOfMonth,
  seasonYear,
} from "../utils/seasons";

export const meteorologicalCalendar: Calendar = {
  id: "meteorological",
  name: "Meteorological seasons",
  bucketTerm: "Season",
  labelForWeekStart(saturday) {
    const lbl = metLabel(saturday);
    return { display: lbl.display, short: lbl.short };
  },
  bucketForDate(date) {
    const s = seasonOfMonth(date.getMonth());
    const y = seasonYear(date);
    return { key: `${y}-${s}`, label: `${s} ${y}` };
  },
};
