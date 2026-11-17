<!-- The reader page: a native sign-in form for a visitor, a status line and a sign-out button
     for a reader (ADR 009: no JavaScript needed). The honeypot sits out of sight and out of
     reach of password managers, like the form block's; `proof.js` fills `_proof` when it runs. -->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const labels = $derived(data.labels);
</script>

<svelte:head>
  <title>{labels.title}</title>
  {#if data.form}<script type="module" src="/_form/proof.js"></script>{/if}
</svelte:head>

<main class="page">
  <h1>{labels.title}</h1>
  {#if data.signedIn}
    <p>{labels.signedIn}</p>
    <form method="post" action={data.signoutAction}>
      <button type="submit">{labels.signout}</button>
    </form>
  {:else if data.form}
    <p>{labels.intro}</p>
    <form
      method="post"
      action={data.form.action}
      class="signup"
      data-proof={JSON.stringify(data.form.proof)}
    >
      {#if form?.message}
        <div class="error-summary" role="alert">
          <p>{form.message}</p>
        </div>
      {/if}
      <input type="hidden" name="_started" value={data.form.startedToken} />
      <input type="hidden" name="_proof" value="" />
      {#if data.form.returnPath}
        <input type="hidden" name="return" value={data.form.returnPath} />
      {/if}
      <div class="hp" aria-hidden="true">
        <label for="reader-website">{labels.honeypot}</label>
        <input
          id="reader-website"
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
        <label for="reader-email">{labels.email}</label>
        <input
          id="reader-email"
          name="email"
          type="email"
          autocomplete="email"
          required
          maxlength="320"
          value={form?.email ?? ''}
        />
      </div>
      <button type="submit">{labels.submit}</button>
    </form>
  {:else}
    <p>{labels.suspended}</p>
  {/if}
</main>
