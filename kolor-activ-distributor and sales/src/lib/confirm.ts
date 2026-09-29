import { supabase } from "./supabase";
import { askPassword } from "./ask";

/** Asks for the signed-in person's password before something like marking someone dormant.
 *  Resolves "ok", "cancelled" or "wrong". */
export async function confirmWithPassword(message: string, ok = "Confirm"): Promise<"ok" | "cancelled" | "wrong"> {
  if (!supabase) return "cancelled";
  const pw = await askPassword(`${message}\n\nEnter your password to confirm.`, { ok });
  if (!pw) return "cancelled";
  const email = (await supabase.auth.getUser()).data.user?.email;
  if (!email) return "wrong";
  const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
  return error ? "wrong" : "ok";
}
