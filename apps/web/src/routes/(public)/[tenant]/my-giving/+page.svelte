<!-- The donor's page without a link: a signed-in reader's gifts (OwnGifts.svelte), or the native
     form that mails a link, or "check your mail" after it. The honeypot sits out of sight and out
     of reach of password managers, like the reader form's; `proof.js` fills `_proof` when it runs. -->
<script lang="ts">
  import OwnGifts from '#lib/components/public/OwnGifts.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const labels = $derived(data.labels);
  // One shape for what any of the actions failed with: a gift's change, or the request form.
  const failure = $derived(form as { gift?: string; email?: string; message?: string } | null);
  const failed = $derived(
    failure?.gift && failure.message ? { gift: failure.gift, message: failure.message } : null
  );
</script>

<svelte:head>
  <title>{labels.title}</title>
  <meta name="robots" content="noindex" />
  {#if data.form}<script type="module" src="/_form/proof.js"></script>{/if}
</svelte:head>

<main class="page own-gifts">
  <h1>{labels.title}</h1>
  {#if data.gifts}
    {#if data.done}<p role="status">{data.done}</p>{/if}
    <p>{labels.intro}</p>
    <OwnGifts gifts={data.gifts} {labels} action={(change) => `${data.base}/${change}`} {failed} />
  {:else if data.sent}
    <p role="status">{labels.sent}</p>
  {:else if data.form}
    <p>{labels.requestIntro}</p>
    <form
      method="post"
      action={data.form.action}
      class="signup"
      data-proof={JSON.stringify(data.form.proof)}
    >
      {#if failure?.email !== undefined && failure.message}
        <div class="error-summary" role="alert">
          <p>{failure.message}</p>
        </div>
      {/if}
      <input type="hidden" name="_started" value={data.form.startedToken} />
      <input type="hidden" name="_proof" value="" />
      <div class="hp" aria-hidden="true">
        <label for="giving-website">{labels.honeypot}</label>
        <input
          id="giving-website"
          name="website"
          type="text"
          tabindex="-1"
          autocomplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
        />
      </div>
      <div class="field" data-form-field>
        <label for="giving-email">{labels.email}</label>
        <input
          id="giving-email"
          name="email"
          type="email"
          autocomplete="email"
          required
          maxlength="320"
          value={failure?.email ?? ''}
        />
      </div>
      <button type="submit">{labels.requestSubmit}</button>
    </form>
  {:else}
    <p>{labels.suspended}</p>
  {/if}
</main>
