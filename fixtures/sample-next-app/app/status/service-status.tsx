'use client';

import { useEffect, useState } from 'react';

// Asks for an endpoint that does not exist, on purpose: the request fails with 404 and the error
// is logged, so bdiff's UI probe has a console error and a failed request to capture.
export function ServiceStatus() {
  const [status, setStatus] = useState('Checking...');

  useEffect(() => {
    fetch('/api/status')
      .then((response) => {
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        setStatus('All systems operational');
      })
      .catch((error: unknown) => {
        console.error(
          'Could not load the service status:',
          error instanceof Error ? error.message : String(error),
        );
        setStatus('Status unavailable');
      });
  }, []);

  return <p>{status}</p>;
}
