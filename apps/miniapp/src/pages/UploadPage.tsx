import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiClientError } from '../api/client.js';
import { shopPath } from '../providers/ShopProvider.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { t } from '../i18n/index.js';

/** A file sent to the bot: goes on to its import screen (products CSV or GB backup). */
export function UploadPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getUpload(id)
      .then((upload) => {
        if (cancelled) return;
        const query = `?upload=${id}`;
        if (upload.kind === 'backup') navigate(`/import-gb${query}`, { replace: true });
        else if (upload.shopSlug) navigate(shopPath(upload.shopSlug, `/admin/products-csv${query}`), { replace: true });
        else setError(t('upload.noShop'));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiClientError ? err.message : t('error.tryAgain'));
      });
    return () => {
      cancelled = true;
    };
  }, [id, navigate]);

  return error ? <ErrorView message={error} /> : <Loader />;
}
