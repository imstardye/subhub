<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Dashboard placeholder for the P3 admin skeleton. User/source/rules pages
 * land in later slices; this only proves the protected shell works.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' });

const cards = [
  { label: '用户', value: '—', hint: '占位：用户列表待实现' },
  { label: '订阅源', value: '—', hint: '占位：订阅源管理待实现' },
  { label: '规则档', value: '—', hint: '占位：规则档管理待实现' },
];
</script>

<template>
  <section>
    <h1>仪表盘</h1>
    <p class="lead">
      P3 管理后台骨架已就绪：登录、会话与受保护布局可用，业务页面随后逐步补齐。
    </p>
    <div class="cards">
      <article v-for="card in cards" :key="card.label" class="card">
        <div class="label">{{ card.label }}</div>
        <div class="value">{{ card.value }}</div>
        <div class="hint">{{ card.hint }}</div>
      </article>
    </div>
  </section>
</template>

<style scoped>
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
}
.lead {
  margin: 0 0 1.5rem;
  color: #4b5563;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 1rem;
}
.card {
  padding: 1rem;
  background: #fff;
  border: 1px solid #e1e6ec;
  border-radius: 8px;
}
.label {
  font-size: 0.85rem;
  color: #6b7785;
}
.value {
  margin: 0.25rem 0;
  font-size: 1.5rem;
  font-weight: 600;
}
.hint {
  font-size: 0.8rem;
  color: #88929e;
}
</style>
