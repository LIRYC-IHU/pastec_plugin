;(function() {
  // Intercept fetch
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    
    // Skip extension and chrome:// URLs
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      return origFetch(input, init);
    }
    
    console.log('[PASTEC] Fetch intercepted:', { url, method: init?.method || 'GET' });
    
    // Check for PDF URLs
    if (/\/api\/documents\/\d+$/.test(url)) {
      console.log('[PASTEC] PDF URL detected, intercepting:', url);
      const resp = await origFetch(input, init);
      
      // Check if it's actually a PDF response
      const contentType = resp.headers.get('content-type');
      if (contentType && contentType.includes('application/pdf')) {
        console.log('[PASTEC] Confirmed PDF response, blocking and capturing');
        const blob = await resp.clone().blob();
        window.dispatchEvent(new CustomEvent('PASTEC_PDF_BLOB', { detail: { url, blob } }));
        
        // Return empty response to prevent PDF display
        return new Response('', {
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/plain' })
        });
      }
      return resp;
    }
    return origFetch(input, init);
  };

  // Intercept XMLHttpRequest
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._pastec_url = url;
    this._pastec_method = method;
    console.log('[PASTEC] XHR open:', { method, url });
    return origXHROpen.call(this, method, url, ...args);
  };
  
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._pastec_url && /\/api\/documents\/\d+$/.test(this._pastec_url)) {
      console.log('[PASTEC] XHR PDF request detected:', this._pastec_url);
      
      const origOnload = this.onload;
      this.onload = function(e) {
        const contentType = this.getResponseHeader('content-type');
        if (contentType && contentType.includes('application/pdf')) {
          console.log('[PASTEC] XHR PDF response intercepted');
          const blob = new Blob([this.response], { type: 'application/pdf' });
          window.dispatchEvent(new CustomEvent('PASTEC_PDF_BLOB', { 
            detail: { url: this._pastec_url, blob } 
          }));
          
          // Prevent original handler
          e.stopImmediatePropagation();
          return;
        }
        if (origOnload) origOnload.call(this, e);
      };
    }
    return origXHRSend.call(this, ...args);
  };
})();

;(function() {
  const originalOpen = window.open.bind(window);
  window.open = (url, name, specs) => {
    // si c’est un blob, on bloque
    if (typeof url === 'string' && url.startsWith('blob:')) {
      console.debug('[PASTEC] Bloqué window.open(blob)');
      return null;
    }
    return originalOpen(url, name, specs);
  };
  
  // empêche aussi toute insertion automatique d’<iframe src="blob:...">
  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n instanceof HTMLIFrameElement && n.src.startsWith('blob:')) {
          console.debug('[PASTEC] suppression iframe blob auto-généré');
          n.remove();
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();