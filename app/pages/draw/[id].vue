<script setup lang="ts">
interface PublicBox {
  number: number
  claimedBy: string | null
  value: string | null
}
interface PublicDraw {
  id: string
  title: string
  mode: 'winner' | 'numbers'
  size: number
  hash: string
  createdAt: number
  expiresAt: number
  complete: boolean
  pickedCount: number
  proof: string | null
  boxes: PublicBox[]
}

const route = useRoute()
const id = String(route.params.id)
const storageKey = `picked_session_${id}`
const NAME_KEY = 'chama_member_name'

const { data: draw, error: loadError, refresh } = await useFetch<PublicDraw>(`/api/draw/${id}`, {
  key: `draw-${id}`,
})

useHead(() => ({
  title: draw.value?.title ? `${draw.value.title} · Chama Lucky Box` : 'Chama Lucky Box',
}))

// ---------- Polling (every 2s until all papers are picked) ----------
let timer: ReturnType<typeof setInterval> | undefined
function startPolling() {
  stopPolling()
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return
    if (draw.value?.complete || loadError.value) return stopPolling()
    refresh()
  }, 2000)
}
function stopPolling() {
  if (timer) clearInterval(timer)
  timer = undefined
}

// ---------- This phone's pick (localStorage) ----------
const myPick = ref<number | null>(null)
function readStorage(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode etc. */ }
}

onMounted(() => {
  const saved = Number(readStorage(storageKey))
  if (Number.isInteger(saved) && saved > 0) myPick.value = saved
  memberName.value = readStorage(NAME_KEY) ?? ''
  startPolling()
})
onBeforeUnmount(stopPolling)

// ---------- Picking flow ----------
const selectedBox = ref<number | null>(null)
const memberName = ref('')
const picking = ref(false)
const pickError = ref('')
const reveal = ref<{ boxNumber: number; value: string } | null>(null)
const justOpened = ref<number | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

const canPick = computed(() => myPick.value === null && !draw.value?.complete)

function openBox(box: PublicBox) {
  if (box.claimedBy || !canPick.value) return
  pickError.value = ''
  selectedBox.value = box.number
  nextTick(() => nameInput.value?.focus())
}

function closeModal() {
  if (picking.value) return
  selectedBox.value = null
}

async function confirmPick() {
  const name = memberName.value.trim()
  if (!name) {
    pickError.value = 'Please type your first name.'
    return
  }
  if (selectedBox.value === null) return
  picking.value = true
  pickError.value = ''
  try {
    const res = await $fetch<{ boxNumber: number; value: string }>(`/api/draw/${id}/pick`, {
      method: 'POST',
      body: { boxNumber: selectedBox.value, memberName: name },
    })
    writeStorage(storageKey, String(res.boxNumber))
    writeStorage(NAME_KEY, name)
    myPick.value = res.boxNumber
    justOpened.value = res.boxNumber
    selectedBox.value = null
    reveal.value = { boxNumber: res.boxNumber, value: res.value }
    await refresh()
  } catch (e: any) {
    pickError.value = e?.data?.message || e?.data?.statusMessage || 'Something went wrong. Please try again.'
    if (e?.statusCode === 409 || e?.response?.status === 409) await refresh()
  } finally {
    picking.value = false
  }
}

// ---------- Display helpers ----------
const progress = computed(() => (draw.value ? Math.round((draw.value.pickedCount / draw.value.size) * 100) : 0))

const isWin = (box: PublicBox) => draw.value?.mode === 'winner' && box.value === 'YES'

function tileClass(box: PublicBox) {
  const opened = box.claimedBy !== null || box.value !== null
  if (!opened) {
    return canPick.value
      ? 'paper-folded cursor-pointer hover:-translate-y-1 hover:shadow-lg hover:shadow-ink/10 active:translate-y-0 active:scale-[0.97]'
      : 'paper-folded opacity-55 cursor-default'
  }
  if (isWin(box)) return 'paper-winner text-ink shadow-lg shadow-gold-500/30'
  return 'bg-white border border-line text-ink'
}

const winnerBox = computed(() =>
  draw.value?.mode === 'winner' ? draw.value.boxes.find(b => b.value === 'YES' && b.claimedBy) : undefined,
)

const payoutOrder = computed(() =>
  draw.value?.mode === 'numbers'
    ? draw.value.boxes
        .filter(b => b.claimedBy && b.value)
        .sort((a, b) => Number(a.value) - Number(b.value))
    : [],
)

// ---------- Share ----------
const requestUrl = useRequestURL()
const shareUrl = computed(() => `${requestUrl.origin}/draw/${id}`)
const shareText = computed(() => {
  const t = draw.value?.title ? `*${draw.value.title}*\n` : ''
  const what = draw.value?.mode === 'numbers'
    ? 'Pick your merry-go-round number.'
    : 'Pick a folded paper. One of them says YES.'
  return `${t}Chama Lucky Box: ${what}\nOpen the link, tap a paper and type your name:\n${shareUrl.value}`
})
const whatsappHref = computed(() => `https://wa.me/?text=${encodeURIComponent(shareText.value)}`)

const copied = ref<'' | 'link' | 'hash' | 'proof'>('')
async function copy(text: string, what: 'link' | 'hash' | 'proof') {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  copied.value = what
  setTimeout(() => { if (copied.value === what) copied.value = '' }, 1600)
}

// ---------- Fairness proof verification (in the browser) ----------
const verifyState = ref<'idle' | 'ok' | 'bad' | 'unsupported'>('idle')
async function verifyProof() {
  if (!draw.value?.proof) return
  if (!globalThis.crypto?.subtle) {
    verifyState.value = 'unsupported'
    return
  }
  const bytes = new TextEncoder().encode(draw.value.proof)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  verifyState.value = hex === draw.value.hash ? 'ok' : 'bad'
}
</script>

<template>
  <div class="mx-auto min-h-dvh max-w-2xl px-4 pb-16">
    <nav class="flex items-center justify-between py-5">
      <AppLogo />
      <NuxtLink to="/" class="btn-ghost h-9 px-3 text-sm">
        <AppIcon name="plus" :size="16" />
        New draw
      </NuxtLink>
    </nav>

    <!-- Not found -->
    <div v-if="loadError || !draw" class="card mt-10 px-6 py-14 text-center">
      <span class="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-paper-dark text-brand-700">
        <AppIcon name="alert" :size="26" />
      </span>
      <h1 class="mt-5 font-display text-2xl font-bold">Draw not found</h1>
      <p class="mx-auto mt-2 max-w-xs text-sm text-muted">
        The link may be incomplete, or this draw expired after 24 hours.
      </p>
      <NuxtLink to="/" class="btn-primary mt-7 h-12 px-6">
        Start a new draw
        <AppIcon name="arrow-right" :size="18" />
      </NuxtLink>
    </div>

    <main v-else>
      <!-- Heading -->
      <header class="pt-2">
        <span class="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
          <AppIcon :name="draw.mode === 'winner' ? 'trophy' : 'list'" :size="13" />
          {{ draw.mode === 'winner' ? 'One winner' : `Numbers 1 to ${draw.size}` }}
        </span>
        <h1 class="mt-3 font-display text-3xl leading-tight font-extrabold tracking-tight sm:text-4xl">
          {{ draw.title || (draw.mode === 'winner' ? 'Who gets the YES?' : 'Merry-go-round order') }}
        </h1>

        <div class="mt-5">
          <div class="flex items-baseline justify-between text-sm">
            <span class="text-muted">
              <strong class="font-semibold text-ink tabular-nums">{{ draw.pickedCount }}</strong>
              of {{ draw.size }} papers picked
            </span>
            <span v-if="!draw.complete" class="flex items-center gap-1.5 text-xs text-muted">
              <span class="relative flex h-2 w-2">
                <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-60" />
                <span class="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
              </span>
              Live
            </span>
            <span v-else class="text-xs font-semibold text-brand-700">Complete</span>
          </div>
          <div class="mt-2 h-2 overflow-hidden rounded-full bg-line">
            <div class="h-full rounded-full bg-brand-600 transition-all duration-500" :style="{ width: `${progress}%` }" />
          </div>
        </div>
      </header>

      <!-- Seal -->
      <section class="card mt-5 p-4">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <AppIcon name="lock" :size="16" class="text-brand-700" />
            Sealed fingerprint
            <span class="font-normal text-muted">SHA-256</span>
          </div>
          <button
            type="button"
            class="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-900"
            @click="copy(draw.hash, 'hash')"
          >
            <AppIcon :name="copied === 'hash' ? 'check' : 'copy'" :size="14" />
            {{ copied === 'hash' ? 'Copied' : 'Copy' }}
          </button>
        </div>
        <code class="mt-2 block rounded-lg bg-paper px-3 py-2 font-mono text-[11px] leading-relaxed break-all text-ink/80">{{ draw.hash }}</code>
        <p class="mt-2 text-xs leading-relaxed text-muted">
          Fixed before anyone picked. Take a screenshot now. After the last pick you can check that it still matches.
        </p>
      </section>

      <!-- Share -->
      <div class="mt-4 grid grid-cols-[1fr_auto] gap-2">
        <a
          :href="whatsappHref"
          target="_blank"
          rel="noopener"
          class="btn h-12 bg-[#25D366] text-white shadow-sm hover:bg-[#1fb857]"
        >
          <AppIcon name="whatsapp" :size="20" />
          Share on WhatsApp
        </a>
        <button type="button" class="btn-ghost h-12 px-4" @click="copy(shareUrl, 'link')">
          <AppIcon :name="copied === 'link' ? 'check' : 'copy'" :size="18" />
          <span class="hidden sm:inline">{{ copied === 'link' ? 'Copied' : 'Copy link' }}</span>
        </button>
      </div>

      <!-- Results when complete -->
      <section v-if="draw.complete" class="mt-8 overflow-hidden rounded-2xl bg-brand-800 text-white shadow-lg shadow-brand-900/20">
        <template v-if="draw.mode === 'winner'">
          <div class="flex items-center gap-4 p-5">
            <span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gold-400 text-brand-900">
              <AppIcon name="trophy" :size="28" />
            </span>
            <div class="min-w-0">
              <p class="text-xs font-semibold tracking-[0.14em] text-white/60 uppercase">The YES paper went to</p>
              <p class="truncate font-display text-2xl font-extrabold">{{ winnerBox?.claimedBy }}</p>
              <p class="text-sm text-white/60">Paper {{ winnerBox?.number }}</p>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="p-5">
            <p class="text-xs font-semibold tracking-[0.14em] text-white/60 uppercase">Payout order</p>
            <ol class="mt-3 divide-y divide-white/10">
              <li v-for="b in payoutOrder" :key="b.number" class="flex items-center gap-3 py-2.5">
                <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 font-display font-bold tabular-nums">
                  {{ b.value }}
                </span>
                <span class="min-w-0 flex-1 truncate font-semibold">{{ b.claimedBy }}</span>
                <span class="text-xs text-white/50">paper {{ b.number }}</span>
              </li>
            </ol>
          </div>
        </template>
      </section>

      <!-- Basket -->
      <section class="mt-8">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="font-display text-lg font-bold">The basket</h2>
          <p v-if="myPick !== null && !draw.complete" class="text-sm text-muted">
            You picked paper <strong class="text-ink">{{ myPick }}</strong>
          </p>
          <p v-else-if="canPick" class="flex items-center gap-1.5 text-sm text-muted">
            <AppIcon name="hand" :size="16" />
            Tap a paper to pick
          </p>
        </div>

        <p v-if="draw.mode === 'numbers' && !draw.complete" class="mb-3 text-sm leading-relaxed text-muted">
          The number on the outside is just the paper's label. Your real number, from 1 to {{ draw.size }},
          is written inside and was shuffled before anyone picked.
        </p>

        <div class="rounded-3xl border border-line bg-paper-dark/50 p-3 sm:p-4">
          <div class="grid grid-cols-3 gap-2.5 sm:grid-cols-4 sm:gap-3">
            <button
              v-for="box in draw.boxes"
              :key="box.number"
              type="button"
              class="relative flex aspect-[4/5] flex-col items-center justify-center overflow-hidden rounded-xl p-2 text-center transition duration-200"
              :class="[
                tileClass(box),
                myPick === box.number && 'ring-2 ring-brand-600 ring-offset-2 ring-offset-paper-dark',
                justOpened === box.number && 'unfold',
              ]"
              :disabled="!!box.claimedBy || !canPick"
              :aria-label="box.claimedBy ? `Paper ${box.number}, picked by ${box.claimedBy}` : `Pick paper ${box.number}`"
              @click="openBox(box)"
            >
              <!-- Folded -->
              <template v-if="!box.claimedBy && box.value === null">
                <span class="dog-ear" aria-hidden="true" />
                <span class="font-display text-4xl font-extrabold text-ink/80 tabular-nums">{{ box.number }}</span>
                <span v-if="canPick" class="mt-1 text-[10px] font-semibold tracking-wider text-muted uppercase">Tap to pick</span>
              </template>

              <!-- Opened -->
              <template v-else>
                <span class="absolute top-2 left-2.5 text-[10px] font-semibold text-current/50 tabular-nums">Paper {{ box.number }}</span>
                <span
                  v-if="myPick === box.number"
                  class="absolute top-1.5 right-1.5 rounded-full bg-brand-700 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase"
                >You</span>

                <template v-if="draw.mode === 'numbers'">
                  <span class="text-[10px] font-semibold tracking-wider text-muted uppercase">Number</span>
                  <span class="font-display text-4xl leading-none font-extrabold text-brand-700 tabular-nums">{{ box.value }}</span>
                </template>
                <template v-else-if="isWin(box)">
                  <AppIcon name="trophy" :size="22" class="text-brand-900" />
                  <span class="mt-1 font-display text-2xl leading-none font-extrabold">YES</span>
                  <span class="text-[10px] font-bold tracking-wider uppercase">Winner</span>
                </template>
                <template v-else>
                  <span class="font-display text-2xl leading-none font-bold text-ink/30">NO</span>
                </template>

                <span class="mt-2 w-full truncate px-1 text-xs font-semibold" :class="isWin(box) ? 'text-brand-900' : 'text-muted'">
                  {{ box.claimedBy ?? 'Not picked' }}
                </span>
              </template>
            </button>
          </div>
        </div>
      </section>

      <!-- Fairness proof -->
      <section class="card mt-8 p-5">
        <div class="flex items-center gap-3">
          <span class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <AppIcon name="shield" />
          </span>
          <div>
            <h2 class="font-semibold">Fairness proof</h2>
            <p class="text-xs text-muted">{{ draw.proof ? 'Unlocked' : 'Unlocks after the last pick' }}</p>
          </div>
        </div>

        <p v-if="!draw.proof" class="mt-4 text-sm leading-relaxed text-muted">
          The full list of papers stays hidden until every paper is picked. It then appears here, and anyone can
          confirm that its SHA-256 equals the fingerprint at the top. A match means
          {{ draw.mode === 'winner' ? 'the YES could not have been moved' : 'the numbers could not have been swapped' }}.
        </p>

        <template v-else>
          <p class="mt-4 text-sm text-muted">The basket exactly as it was sealed at the start:</p>
          <div class="relative mt-2">
            <code class="block rounded-lg bg-paper p-3 pr-10 font-mono text-xs leading-relaxed break-all text-ink/80">{{ draw.proof }}</code>
            <button
              type="button"
              class="absolute top-2 right-2 grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-white hover:text-ink"
              aria-label="Copy proof"
              @click="copy(draw.proof, 'proof')"
            >
              <AppIcon :name="copied === 'proof' ? 'check' : 'copy'" :size="14" />
            </button>
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" class="btn h-10 bg-ink px-4 text-sm text-white hover:bg-ink/90" @click="verifyProof">
              <AppIcon name="shield" :size="16" />
              Verify fingerprint
            </button>
            <span v-if="verifyState === 'ok'" class="flex items-center gap-1.5 text-sm font-semibold text-brand-700">
              <AppIcon name="check" :size="16" /> Matches. This draw was fair.
            </span>
            <span v-else-if="verifyState === 'bad'" class="flex items-center gap-1.5 text-sm font-semibold text-red-700">
              <AppIcon name="x" :size="16" /> Does not match.
            </span>
            <span v-else-if="verifyState === 'unsupported'" class="text-sm text-muted">
              This browser can only check on HTTPS. Paste the proof into any SHA-256 tool instead.
            </span>
          </div>
        </template>
      </section>
    </main>

    <!-- Name sheet -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="selectedBox !== null"
          class="fixed inset-0 z-40 flex items-end justify-center bg-ink/50 backdrop-blur-sm sm:items-center sm:p-4"
          @click.self="closeModal"
        >
          <form
            class="sheet w-full max-w-sm rounded-t-3xl bg-white p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl"
            @submit.prevent="confirmPick"
          >
            <div class="mx-auto mb-5 h-1 w-10 rounded-full bg-line sm:hidden" />
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="eyebrow">Paper {{ selectedBox }}</p>
                <h2 class="mt-1 font-display text-2xl font-extrabold">Is this your pick?</h2>
              </div>
              <button type="button" class="-mt-1 -mr-2 grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-paper" aria-label="Close" @click="closeModal">
                <AppIcon name="x" :size="18" />
              </button>
            </div>
            <p class="mt-2 text-sm text-muted">Type your first name. Each member can pick only once.</p>

            <input
              ref="nameInput"
              v-model="memberName"
              type="text"
              maxlength="30"
              autocomplete="given-name"
              placeholder="Your first name"
              class="input mt-5 h-13 text-lg"
            >
            <p v-if="pickError" class="mt-3 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">
              <AppIcon name="alert" :size="18" class="mt-px shrink-0" />
              {{ pickError }}
            </p>

            <button type="submit" class="btn-primary mt-5 h-13 w-full text-base" :disabled="picking">
              {{ picking ? 'Unfolding…' : 'Open my paper' }}
            </button>
          </form>
        </div>
      </Transition>
    </Teleport>

    <!-- Reveal -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="reveal"
          class="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-6 backdrop-blur-sm"
          @click="reveal = null"
        >
          <div
            class="unfold w-full max-w-xs rounded-3xl p-8 text-center shadow-2xl"
            :class="draw?.mode === 'winner' && reveal.value === 'YES' ? 'paper-winner' : 'bg-paper'"
          >
            <p class="text-xs font-semibold tracking-[0.14em] text-ink/50 uppercase">You opened paper {{ reveal.boxNumber }}</p>

            <template v-if="draw?.mode === 'numbers'">
              <p class="mt-6 text-sm text-muted">Your number is</p>
              <p class="font-display text-8xl leading-none font-extrabold text-brand-700 tabular-nums">{{ reveal.value }}</p>
              <p class="mt-3 text-sm text-muted">in the payout order of {{ draw?.size }}</p>
            </template>
            <template v-else-if="reveal.value === 'YES'">
              <span class="mx-auto mt-6 grid h-16 w-16 place-items-center rounded-2xl bg-brand-800 text-gold-300">
                <AppIcon name="trophy" :size="32" />
              </span>
              <p class="mt-5 font-display text-4xl leading-none font-extrabold">YES</p>
              <p class="mt-1 font-display text-xl font-bold text-brand-900">WINNER!</p>
            </template>
            <template v-else>
              <p class="mt-6 font-display text-5xl leading-none font-extrabold text-ink/30">NO</p>
              <p class="mt-3 font-semibold text-muted">Try again next time</p>
            </template>

            <button type="button" class="btn-ghost mt-8 h-11 w-full text-sm">Close</button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.paper-folded {
  background:
    linear-gradient(135deg, transparent calc(50% - 0.5px), var(--color-crease) 50%, transparent calc(50% + 0.5px)),
    linear-gradient(160deg, #fffdf7 0%, var(--color-paper) 55%, var(--color-paper-dark) 100%);
  border: 1px solid var(--color-crease);
  box-shadow: 0 1px 0 rgb(255 255 255 / 0.8) inset, 0 2px 6px rgb(60 45 20 / 0.08);
}
.paper-winner {
  background: linear-gradient(150deg, var(--color-gold-300) 0%, var(--color-gold-400) 55%, var(--color-gold-500) 100%);
}
.dog-ear {
  position: absolute;
  top: 0;
  right: 0;
  width: 18px;
  height: 18px;
  background: linear-gradient(225deg, var(--color-paper-dark) 50%, var(--color-crease) 50%);
  border-bottom-left-radius: 4px;
  box-shadow: -1px 1px 2px rgb(60 45 20 / 0.12);
}
.unfold {
  animation: unfold 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.15);
  transform-origin: top center;
}
@keyframes unfold {
  0% { transform: perspective(700px) rotateX(-85deg) scale(0.85); opacity: 0; }
  100% { transform: perspective(700px) rotateX(0) scale(1); opacity: 1; }
}
.sheet { animation: rise 0.25s ease-out; }
@keyframes rise {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .unfold, .sheet { animation: none; }
}
</style>
