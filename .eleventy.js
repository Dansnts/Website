module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("blog/posts/assets");

  eleventyConfig.addFilter("dateStr", (date) => {
    return new Date(date).toLocaleDateString("fr-CH", {
      year: "numeric", month: "long", day: "numeric"
    });
  });

  return {
    pathPrefix: "/blog/",
    dir: {
      input: "blog",
      includes: "_includes",
      output: "www/blog",
    },
    templateFormats: ["md", "njk", "html"],
  };
};
