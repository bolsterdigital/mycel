// The capability set a role picker posted (#101, lib/admin/ui/form/RolePicker.svelte). A preset
// role becomes its set in core; `custom`, or a post without a role (an older form, a script),
// reads the ticked capabilities. The use cases get a capability set as before, so `requires` and
// their inputs are unchanged. Rejected: a `role` input on the use cases, which would put a second
// way to say the same thing into HTTP and MCP.
import { capabilitiesFor, PresetRole } from '@mycel/core';

export function postedCapabilities(data: FormData): string[] {
  const role = PresetRole.safeParse(data.get('role'));
  return role.success ? capabilitiesFor(role.data) : data.getAll('capabilities').map(String);
}
