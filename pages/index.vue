<script setup lang="ts">
const capabilities = [
  'Share-link parsers: ss / vmess / vless (reality) / trojan / hysteria2 / tuic / anytls',
  'Clash YAML and base64 subscriptions',
  'mihomo and legacy Clash producers',
  'subconverter-style ruleset and custom_proxy_group parsing',
];
</script>

<template>
  <main class="wrap">
    <h1>subhub</h1>
    <p>P1 core is ready. The management UI arrives in a later phase.</p>
    <ul>
      <li v-for="item in capabilities" :key="item">{{ item }}</li>
    </ul>
  </main>
</template>

<style scoped>
.wrap {
  max-width: 56rem;
  margin: 4rem auto;
  padding: 0 1.25rem;
  font-family: ui-sans-serif, system-ui, sans-serif;
  line-height: 1.65;
}
ul {
  padding-left: 1.25rem;
}
</style>
