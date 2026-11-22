<!-- A campaign's action area (ADR 038 rules 5-7): the count, then the form while participation is
     open, or where participation stands instead (closed: the final count against the goal; not
     yet open: the opening date when there is one, without a count). One component for the
     landing page and the card. On the landing page it is a section with its own heading
     (`level`); in a card the card title names it (`level` null), as Dreamkit's card did. The
     server still decides at submit (ADR 033 rule 3); this only keeps the page from offering a
     post it would refuse. A compact form marks the area `campaign-action-sticky`, which
     campaign.css keeps in view beside the text, bounded by the layout (MY-267 PR 5). -->
<script lang="ts">
  import CampaignCount from './CampaignCount.svelte';
  import { compactForm } from './campaign-render.js';
  import Form from './Form.svelte';
  import { headingTag } from './headings.js';
  import type { FormState, RenderLanding, RenderModel } from './model.js';

  let {
    campaign,
    model,
    id,
    level,
    state = null,
    preview = null,
    note = null,
  }: {
    campaign: RenderLanding;
    model: RenderModel;
    /** The prefix of every element id in the area. */
    id: string;
    /** The heading level of the area's own title, or null for none (a card). */
    level: number | null;
    state?: FormState | null;
    /** The admin preview's note for the form, which then does not post. */
    preview?: string | null;
    /** The admin preview's words for a form the public page does not show now. */
    note?: string | null;
  } = $props();

  const copy = $derived(model.copy.campaign);
  const sticky = $derived(compactForm(campaign.form));
  const open = $derived(campaign.phase === 'open');
  const title = $derived(
    open ? copy.act[campaign.kind] : copy.heading[campaign.phase as 'upcoming' | 'closed']
  );
  const stand = $derived(
    open
      ? null
      : campaign.phase === 'upcoming' && campaign.opens
        ? copy.opensOn.replace('{date}', () => campaign.opens!.label)
        : copy.notOpen[campaign.phase as 'upcoming' | 'closed']
  );
</script>

{#snippet body()}
  {#if stand}<p class="campaign-stand">{stand}</p>{/if}
  {#if campaign.phase !== 'upcoming'}<CampaignCount {campaign} {model} {id} />{/if}
  {#if note}<p class="preview-note preview-note-warning">{note}</p>{/if}
  {#if campaign.form}
    <Form form={campaign.form} variant="default" width="content" {model} {state} {preview} />
  {/if}
{/snippet}

{#if level !== null}
  <section
    class="campaign-action"
    class:campaign-action-sticky={sticky}
    aria-labelledby="{id}-action"
  >
    <svelte:element this={headingTag(level)} id="{id}-action">{title}</svelte:element>
    {@render body()}
  </section>
{:else}
  <div class="campaign-action" class:campaign-action-sticky={sticky}>{@render body()}</div>
{/if}
