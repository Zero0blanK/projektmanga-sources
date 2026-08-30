import type { MangaFilter, Option } from '../lib/types.js';
import type { MangaDexTag } from './schema.js';

/** Pure filter-list builder, split out of getFilters() so the tag-fetch (network, cache,
 * error handling) and the filter-shape construction (this) aren't tangled together. */
export function buildMangaDexFilters(tagData: MangaDexTag[]): MangaFilter[] {
  const sortByFilter: MangaFilter = {
    label: 'Sort By',
    value: 'sortBy',
    type: 'select',
    options: [
      { label: 'None', value: '' },
      { label: 'Best Match', value: 'relevance.desc' },
      { label: 'Latest Upload', value: 'latestUploadedChapter.desc' },
      { label: 'Oldest Upload', value: 'latestUploadedChapter.asc' },
      { label: 'Title Ascending', value: 'title.asc' },
      { label: 'Title Descending', value: 'title.desc' },
      { label: 'Highest Rating', value: 'rating.desc' },
      { label: 'Lowest Rating', value: 'rating.asc' },
      { label: 'Most Follows', value: 'followedCount.desc' },
      { label: 'Fewest Follows', value: 'followedCount.asc' },
      { label: 'Recently Added', value: 'createdAt.desc' },
      { label: 'Oldest Added', value: 'createdAt.asc' },
      { label: 'Year Ascending', value: 'year.asc' },
      { label: 'Year Descending', value: 'year.desc' },
    ],
  };
  const statusFilter: MangaFilter = {
    label: 'Status',
    value: 'status',
    type: 'multi',
    options: [
      { label: 'Ongoing', value: 'ongoing' },
      { label: 'Completed', value: 'completed' },
      { label: 'Hiatus', value: 'hiatus' },
      { label: 'Cancelled', value: 'cancelled' },
    ],
  };
  const demographicFilter: MangaFilter = {
    label: 'Magazine Demographic',
    value: 'demographic',
    type: 'multi',
    options: [
      { label: 'Shounen', value: 'shounen' },
      { label: 'Shoujo', value: 'shoujo' },
      { label: 'Seinen', value: 'seinen' },
      { label: 'Josei', value: 'josei' },
      { label: 'None', value: 'none' },
    ],
  };
  const contentRatingFilter: MangaFilter = {
    label: 'Content Rating',
    value: 'contentRating',
    type: 'multi',
    options: [
      { label: 'Safe', value: 'safe' },
      { label: 'Suggestive', value: 'suggestive' },
      { label: 'Erotica', value: 'erotica' },
    ],
  };

  const genreTags: Option[] = tagData
    .filter((tag) => tag.attributes.group === 'genre')
    .map((tag) => ({ label: tag.attributes.name.en, value: tag.id }));
  const formatTags: Option[] = tagData
    .filter((tag) => tag.attributes.group === 'format')
    .map((tag) => ({ label: tag.attributes.name.en, value: tag.id }));
  const themeTags: Option[] = tagData
    .filter((tag) => tag.attributes.group === 'theme')
    .map((tag) => ({ label: tag.attributes.name.en, value: tag.id }));
  const contentTags: Option[] = tagData
    .filter((tag) => tag.attributes.group === 'content')
    .map((tag) => ({ label: tag.attributes.name.en, value: tag.id }));

  const genreFilter: MangaFilter = {
    label: 'Genre',
    value: 'genre',
    type: 'tri-state',
    options: genreTags,
  };
  const formatFilter: MangaFilter = {
    label: 'Format',
    value: 'format',
    type: 'tri-state',
    options: formatTags,
  };
  const themeFilter: MangaFilter = {
    label: 'Theme',
    value: 'theme',
    type: 'tri-state',
    options: themeTags,
  };
  const contentFilter: MangaFilter = {
    label: 'Content',
    value: 'content',
    type: 'tri-state',
    options: contentTags,
  };

  const includedTagsFilter: MangaFilter = {
    label: 'Inclusion Tag Mode',
    value: 'includedTags',
    type: 'select',
    options: [
      { label: 'And', value: 'AND' },
      { label: 'Or', value: 'OR' },
    ],
  };

  const excludedTagsFilter: MangaFilter = {
    label: 'Exclusion Tag Mode',
    value: 'excludedTags',
    type: 'select',
    options: [
      { label: 'Or', value: 'OR' },
      { label: 'And', value: 'AND' },
    ],
  };

  const publicationYearFilter: MangaFilter = {
    label: 'Publication Year',
    value: 'publicationYear',
    type: 'input',
  };

  return [
    sortByFilter,
    statusFilter,
    demographicFilter,
    contentRatingFilter,
    genreFilter,
    formatFilter,
    themeFilter,
    contentFilter,
    includedTagsFilter,
    excludedTagsFilter,
    publicationYearFilter,
  ];
}
