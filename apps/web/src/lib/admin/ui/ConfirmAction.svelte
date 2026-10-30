<!-- A dangerous action confirmed in place (brief #81: revoke a key, remove a member, delete a
     domain): a disclosure whose summary names the action and whose body asks the question and
     holds the one submit button that does it. The same two steps with and without JavaScript,
     inside the row it acts on, so the form around the row posts it. `name` goes into the accessible
     name of the button that acts, so a list of rows does not offer ten equal "Yes, revoke" buttons
     (WCAG 2.4.6), without a long identifier, which a button cannot break, in the visible label;
     the accessible name starts with the visible one (WCAG 2.5.3). Rejected: a visually hidden span,
     which Chromium reads with a space before its colon and whose unwrapped text runs past a
     narrow card.
     Rejected: a confirm() dialog (needs a script, and a script the admin does not ship), a separate
     confirmation page (leaves the row), and a <dialog> per row (one more heading per row). -->
<script lang="ts">
  let {
    label,
    question,
    confirm,
    name,
    formaction,
  }: {
    /** The action, on the summary: "Revoke". */
    label: string;
    question: string;
    /** The submit button's label: "Yes, revoke". */
    confirm: string;
    /** What the action is about, read after both labels. */
    name?: string | undefined;
    /** The action the submit posts to, when the row's form has another. */
    formaction?: string | undefined;
  } = $props();
</script>

<details class="ui-fold ui-confirm">
  <summary class="ui-button secondary">{label}</summary>
  <div class="ui-confirm-body">
    <p>{question}</p>
    <button
      class="ui-button danger"
      type="submit"
      {formaction}
      aria-label={name ? `${confirm}: ${name}` : undefined}>{confirm}</button
    >
  </div>
</details>
