<script setup lang="ts">
type Mode = 'winner' | 'numbers'

const title = ref('')
const size = ref(8)
const mode = ref<Mode>('winner')
const loading = ref(false)
const error = ref('')

const MIN = 2
const MAX = 100

const modes = [
  { value: 'winner' as const, icon: 'trophy' as const, label: 'One winner', hint: 'One paper says YES, the rest say NO' },
  { value: 'numbers' as const, icon: 'list' as const, label: 'Numbers 1 to N', hint: 'Sets the merry-go-round order' },
]

const steps = [
  { title: 'Create the draw', body: 'Choose how many papers and what is written on them.' },
  { title: 'Share on WhatsApp', body: 'Members open the link and tap one folded paper each.' },
  { title: 'Check it was fair', body: 'When the last paper is picked, anyone can verify the seal.' },
]

function bump(delta: number) {
  size.value = Math.min(MAX, Math.max(MIN, (Number(size.value) || MIN) + delta))
}

async function createDraw() {
  error.value = ''
  const n = Math.round(Number(size.value))
  if (!Number.isFinite(n) || n < MIN || n > MAX) {
    error.value = `Choose between ${MIN} and ${MAX} papers.`
    return
  }
  loading.value = true
  try {
    const res = await $fetch<{ id: string }>('/api/draw/create', {
      method: 'POST',
      body: { title: title.value, size: n, mode: mode.value },
    })
    await navigateTo(`/draw/${res.id}`)
  } catch (e: any) {
    error.value = e?.data?.message || e?.data?.statusMessage || 'Could not create the draw. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-lg flex-col px-4">
    <nav class="flex items-center justify-between py-5">
      <AppLogo />
    </nav>

    <main class="flex-1 pb-10">
      <header class="pt-6 pb-8">
        <p class="eyebrow">For savings groups</p>
        <h1 class="mt-3 font-display text-[2.6rem] leading-[1.05] font-extrabold tracking-tight">
          The paper basket,<br>
          <span class="text-brand-700">on everyone's phone.</span>
        </h1>
        <p class="mt-4 max-w-sm text-[15px] leading-relaxed text-muted">
          Run a fair draw for your chama in seconds. No accounts, no app to install. Just send a link.
        </p>
      </header>

      <form class="card space-y-7 p-5 sm:p-6" @submit.prevent="createDraw">
        <!-- Mode -->
        <fieldset>
          <legend class="mb-3 text-sm font-semibold">What's written on the papers?</legend>
          <div class="grid gap-3 sm:grid-cols-2">
            <button
              v-for="m in modes"
              :key="m.value"
              type="button"
              class="group relative flex items-start gap-3 rounded-xl border p-4 text-left transition"
              :class="mode === m.value
                ? 'border-brand-600 bg-brand-50 ring-4 ring-brand-500/10'
                : 'border-line bg-white hover:border-brand-500/40'"
              :aria-pressed="mode === m.value"
              @click="mode = m.value"
            >
              <span
                class="grid h-10 w-10 shrink-0 place-items-center rounded-lg transition"
                :class="mode === m.value ? 'bg-brand-700 text-white' : 'bg-paper-dark text-brand-700'"
              >
                <AppIcon :name="m.icon" :size="20" />
              </span>
              <span class="min-w-0">
                <span class="block font-semibold">{{ m.label }}</span>
                <span class="mt-0.5 block text-xs leading-snug text-muted">{{ m.hint }}</span>
              </span>
              <span
                v-if="mode === m.value"
                class="absolute top-3 right-3 grid h-5 w-5 place-items-center rounded-full bg-brand-700 text-white"
              >
                <AppIcon name="check" :size="12" />
              </span>
            </button>
          </div>
        </fieldset>

        <!-- Size -->
        <div>
          <label for="size" class="mb-3 block text-sm font-semibold">How many members?</label>
          <div class="flex items-stretch overflow-hidden rounded-xl border border-line bg-white shadow-sm focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/15">
            <button
              type="button"
              class="grid w-16 shrink-0 place-items-center text-ink transition hover:bg-paper active:bg-paper-dark"
              aria-label="Fewer"
              @click="bump(-1)"
            >
              <AppIcon name="minus" />
            </button>
            <input
              id="size"
              v-model.number="size"
              type="number"
              inputmode="numeric"
              :min="MIN"
              :max="MAX"
              class="h-16 w-full min-w-0 border-x border-line text-center font-display text-3xl font-bold focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            >
            <button
              type="button"
              class="grid w-16 shrink-0 place-items-center text-ink transition hover:bg-paper active:bg-paper-dark"
              aria-label="More"
              @click="bump(1)"
            >
              <AppIcon name="plus" />
            </button>
          </div>
          <p class="mt-2 text-xs text-muted">One folded paper per member, from {{ MIN }} to {{ MAX }}.</p>
        </div>

        <!-- Title -->
        <div>
          <label for="title" class="mb-3 block text-sm font-semibold">
            Name this draw <span class="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="title"
            v-model="title"
            type="text"
            maxlength="60"
            placeholder="e.g. Umoja Chama, March payout"
            class="input"
          >
        </div>

        <p v-if="error" class="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">
          <AppIcon name="alert" :size="18" class="mt-px shrink-0" />
          {{ error }}
        </p>

        <button type="submit" :disabled="loading" class="btn-primary h-14 w-full text-base">
          <span>{{ loading ? 'Folding the papers…' : 'Create draw and get link' }}</span>
          <AppIcon v-if="!loading" name="arrow-right" :size="18" />
        </button>
      </form>

      <section class="mt-12">
        <h2 class="eyebrow">How it works</h2>
        <ol class="mt-5 space-y-5">
          <li v-for="(s, i) in steps" :key="s.title" class="flex gap-4">
            <span class="font-display text-sm font-bold text-brand-600 tabular-nums">0{{ i + 1 }}</span>
            <div class="border-l border-line pl-4">
              <h3 class="font-semibold">{{ s.title }}</h3>
              <p class="mt-0.5 text-sm text-muted">{{ s.body }}</p>
            </div>
          </li>
        </ol>
      </section>

      <section class="card mt-10 flex gap-4 p-5">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <AppIcon name="shield" />
        </span>
        <div>
          <h2 class="font-semibold">Sealed before anyone picks</h2>
          <p class="mt-1 text-sm leading-relaxed text-muted">
            The papers are shuffled by the server and sealed with a SHA-256 fingerprint shown to everyone
            from the start. Nobody, not even the person who created the draw, can move the YES afterwards.
          </p>
        </div>
      </section>
    </main>

    <footer class="flex items-center gap-2 border-t border-line py-6 text-xs text-muted">
      <AppIcon name="clock" :size="14" />
      Draws are deleted automatically after 24 hours.
    </footer>
  </div>
</template>
