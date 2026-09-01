const express = require('express');
const router = express.Router();
const { Course, Chapter, Lesson } = require('../models/Course');
const { AudioAsset } = require('../models/Audio');
const User = require('../models/User');
const Word = require('../models/Word');
const auth = require('../middleware/auth');
const audioService = require('../services/audioService');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

router.use(auth);

function getFallbackState() {
  if (!global.__vocabCmsFallbackState) {
    global.__vocabCmsFallbackState = {
      courses: [],
      chapters: [],
      lessons: [],
      counters: { course: 0, chapter: 0, lesson: 0 },
    };
  }
  return global.__vocabCmsFallbackState;
}

function nextFallbackId(type) {
  const state = getFallbackState();
  state.counters[type] = (state.counters[type] || 0) + 1;
  return `${type}-${state.counters[type]}`;
}

function buildFallbackCourse(course) {
  return {
    ...course,
    title: course.name || course.title,
    chaptersCount: Array.isArray(course.chapters) ? course.chapters.length : 0,
    isEnrolled: Array.isArray(course.enrolledStudents) && course.enrolledStudents.some((studentId) => String(studentId) === String(course.viewerId || '')),
  };
}

function getFallbackCourseById(courseId) {
  const state = getFallbackState();
  return state.courses.find((course) => String(course._id) === String(courseId));
}

function getFallbackChapterById(chapterId) {
  const state = getFallbackState();
  return state.chapters.find((chapter) => String(chapter._id) === String(chapterId));
}

function getFallbackLessonById(lessonId) {
  const state = getFallbackState();
  return state.lessons.find((lesson) => String(lesson._id) === String(lessonId));
}

function buildFallbackLessonPayload(lesson) {
  return {
    _id: lesson._id,
    courseId: lesson.courseId,
    chapterId: lesson.chapterId,
    title: lesson.title,
    description: lesson.description,
    order: lesson.order,
    exercises: Array.isArray(lesson.exercises) ? lesson.exercises : [],
    objectives: Array.isArray(lesson.objectives) ? lesson.objectives : [],
    newWords: Array.isArray(lesson.newWords) ? lesson.newWords : [],
    reviewWords: Array.isArray(lesson.reviewWords) ? lesson.reviewWords : [],
    difficulty: lesson.difficulty,
    estimatedDuration: lesson.estimatedDuration,
    isPublished: Boolean(lesson.isPublished),
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt,
    chapterTitle: lesson.chapterTitle || 'Chapter',
  };
}

function ensureFallbackChapter(course, title = 'Default Chapter') {
  const state = getFallbackState();
  let chapter = state.chapters.find((entry) => String(entry.courseId) === String(course._id) && String(entry.title) === String(title));
  if (chapter) return chapter;
  chapter = {
    _id: nextFallbackId('chapter'),
    courseId: course._id,
    title,
    description: 'Starter chapter created automatically.',
    order: 0,
    lessons: [],
    createdAt: new Date().toISOString(),
  };
  state.chapters.push(chapter);
  if (!Array.isArray(course.chapters)) {
    course.chapters = [];
  }
  if (!course.chapters.includes(chapter._id)) {
    course.chapters.push(chapter._id);
  }
  return chapter;
}

// Ensure creator/admin access
const creatorOnly = async (req, res, next) => {
  if (!isDbConnected()) {
    const user = devStore.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    if (user.role !== 'creator' && user.role !== 'admin') {
      return res.status(403).json({ message: 'Only creators and admins can access this.' });
    }
    return next();
  }

  const user = await User.findById(req.user.id).select('role');
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }
  if (user.role !== 'creator' && user.role !== 'admin') {
    return res.status(403).json({ message: 'Only creators and admins can access this.' });
  }
  next();
};

// ============================================================================
// COURSE MANAGEMENT
// ============================================================================

// GET /api/cms/courses - List courses for creators or published courses for students
router.get('/courses', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const skip = Math.max(parseInt(req.query.skip) || 0, 0);

    if (!isDbConnected()) {
      const viewer = devStore.findUserById(req.user.id);
      if (!viewer) {
        return res.status(404).json({ message: 'User not found.' });
      }

      const state = getFallbackState();
      const isCreatorView = viewer.role === 'creator' || viewer.role === 'admin';
      const courseList = (state.courses || [])
        .filter((course) => (isCreatorView ? String(course.creatorId) === String(req.user.id) : Boolean(course.isPublished)))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(skip, skip + limit);

      const normalizedCourses = courseList.map((course) => {
        const enrolled = Array.isArray(course.enrolledStudents)
          ? course.enrolledStudents.some((studentId) => String(studentId) === String(req.user.id))
          : false;
        return {
          ...course,
          _id: course._id,
          title: course.name || course.title,
          isEnrolled: enrolled,
          chaptersCount: Array.isArray(course.chapters) ? course.chapters.length : 0,
        };
      });

      return res.json({ courses: normalizedCourses, total: normalizedCourses.length, limit, skip });
    }

    const viewer = await User.findById(req.user.id).select('role');
    if (!viewer) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const isCreatorView = viewer.role === 'creator' || viewer.role === 'admin';
    const query = isCreatorView ? { creatorId: req.user.id } : { isPublished: true };

    const total = await Course.countDocuments(query);
    const courses = await Course.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .populate('chapters');

    const normalizedCourses = courses.map((course) => {
      const data = course.toObject ? course.toObject() : course;
      const enrolled = Array.isArray(data.enrolledStudents)
        ? data.enrolledStudents.some((studentId) => String(studentId) === String(req.user.id))
        : false;
      return {
        ...data,
        _id: data._id,
        title: data.name,
        isEnrolled: enrolled,
        chaptersCount: data.chapters?.length || 0,
      };
    });

    res.json({ courses: normalizedCourses, total, limit, skip });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch courses.' });
  }
});

// POST /api/cms/courses - Create course
router.post('/courses', creatorOnly, async (req, res) => {
  try {
    const {
      name,
      title,
      description,
      language,
      targetLanguage,
      nativeLanguage,
      level,
      coverImage,
      color,
      isPublished,
      isPublic,
    } = req.body;

    const courseName = String(title || name || '').trim();
    const resolvedTargetLanguage = String(targetLanguage || 'English').trim();
    const resolvedIsPublished = isPublished !== undefined ? Boolean(isPublished) : true;
    const resolvedIsPublic = isPublic !== undefined ? Boolean(isPublic) : true;

    if (!courseName || !resolvedTargetLanguage) {
      return res.status(400).json({ message: 'Name and target language are required.' });
    }

    if (!isDbConnected()) {
      const state = getFallbackState();
      const course = {
        _id: nextFallbackId('course'),
        creatorId: req.user.id,
        name: courseName,
        description,
        language: language || nativeLanguage || 'en',
        targetLanguage: resolvedTargetLanguage,
        nativeLanguage: nativeLanguage || 'en',
        level: level || 'A1',
        coverImage,
        color: color || '#D4AF37',
        slug: courseName.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, ''),
        chapters: [],
        enrolledStudents: [],
        isPublished: resolvedIsPublished,
        isPublic: resolvedIsPublic,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.courses.push(course);
      return res.status(201).json({ course: { ...course, title: course.name } });
    }

    // Generate slug
    const slug = courseName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w-]/g, '');

    const course = new Course({
      creatorId: req.user.id,
      name: courseName,
      description,
      language: language || nativeLanguage || 'en',
      targetLanguage: resolvedTargetLanguage,
      nativeLanguage: nativeLanguage || 'en',
      level: level || 'A1',
      coverImage,
      color: color || '#D4AF37', // Default golden color
      slug,
      chapters: [],
      enrolledStudents: [],
      isPublished: resolvedIsPublished,
      isPublic: resolvedIsPublic,
    });

    await course.save();
    res.status(201).json({ course: { ...course.toObject(), title: course.name } });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create course.' });
  }
});

// POST /api/cms/courses/:courseId/enroll - Enroll a student in a published course
router.post('/courses/:courseId/enroll', async (req, res) => {
  try {
    if (!isDbConnected()) {
      const course = getFallbackCourseById(req.params.courseId);
      if (!course) {
        return res.status(404).json({ message: 'Course not found.' });
      }

      if (!course.isPublished && String(course.creatorId) !== String(req.user.id)) {
        return res.status(403).json({ message: 'Course is not available for enrollment.' });
      }

      if (!Array.isArray(course.enrolledStudents)) {
        course.enrolledStudents = [];
      }
      const alreadyEnrolled = course.enrolledStudents.some((studentId) => String(studentId) === String(req.user.id));
      if (!alreadyEnrolled) {
        course.enrolledStudents.push(req.user.id);
      }
      return res.json({ enrolled: true, courseId: course._id, courseName: course.name });
    }

    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found.' });
    }

    if (!course.isPublished && String(course.creatorId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Course is not available for enrollment.' });
    }

    const alreadyEnrolled = Array.isArray(course.enrolledStudents)
      ? course.enrolledStudents.some((studentId) => String(studentId) === String(req.user.id))
      : false;

    if (!alreadyEnrolled) {
      course.enrolledStudents.push(req.user.id);
      await course.save();
    }

    res.json({ enrolled: true, courseId: course._id, courseName: course.name });
  } catch (err) {
    res.status(500).json({ message: 'Failed to enroll in course.' });
  }
});

// DELETE /api/cms/courses/:id - Delete course
router.delete('/courses/:id', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      const state = getFallbackState();
      const course = state.courses.find((entry) => String(entry._id) === String(req.params.id));
      if (!course) {
        return res.status(404).json({ message: 'Course not found.' });
      }

      if (String(course.creatorId) !== String(req.user.id)) {
        return res.status(403).json({ message: 'Access denied.' });
      }

      state.courses = state.courses.filter((entry) => String(entry._id) !== String(req.params.id));
      state.chapters = state.chapters.filter((entry) => String(entry.courseId) !== String(req.params.id));
      state.lessons = state.lessons.filter((entry) => String(entry.courseId) !== String(req.params.id));
      return res.json({ message: 'Course deleted.' });
    }

    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ message: 'Course not found.' });
    }

    if (String(course.creatorId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    await Course.findByIdAndDelete(req.params.id);
    await Chapter.deleteMany({ courseId: req.params.id });
    await Lesson.deleteMany({ courseId: req.params.id });
    res.json({ message: 'Course deleted.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete course.' });
  }
});

// GET /api/cms/courses/:id - Get course details
router.get('/courses/:id', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      const course = getFallbackCourseById(req.params.id);
      if (!course) {
        return res.status(404).json({ message: 'Course not found.' });
      }

      if (String(course.creatorId) !== String(req.user.id)) {
        return res.status(403).json({ message: 'Access denied.' });
      }

      const state = getFallbackState();
      const chapters = state.chapters.filter((entry) => String(entry.courseId) === String(course._id));
      return res.json({ course: { ...course, chapters } });
    }

    const course = await Course.findById(req.params.id)
      .populate({
        path: 'chapters',
        populate: {
          path: 'lessons',
        },
      });

    if (!course) {
      return res.status(404).json({ message: 'Course not found.' });
    }

    if (course.creatorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    res.json({ course });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch course.' });
  }
});

// PUT /api/cms/courses/:id - Update course
router.put('/courses/:id', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const { name, description, isPublished, isPublic } = req.body;

    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ message: 'Course not found.' });
    }

    if (course.creatorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    if (name) course.name = name;
    if (description !== undefined) course.description = description;
    if (isPublished !== undefined) course.isPublished = isPublished;
    if (isPublic !== undefined) course.isPublic = isPublic;

    course.updatedAt = new Date();
    await course.save();

    res.json({ course });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update course.' });
  }
});

// ============================================================================
// CHAPTER MANAGEMENT
// ============================================================================

// POST /api/cms/courses/:courseId/chapters - Add chapter
router.post('/courses/:courseId/chapters', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const { title, description, theme, order } = req.body;

    const course = await Course.findById(req.params.courseId);
    if (!course || course.creatorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const chapter = new Chapter({
      courseId: req.params.courseId,
      title,
      description,
      theme,
      order: order || course.chapters.length,
      lessons: [],
    });

    await chapter.save();

    // Add to course
    course.chapters.push(chapter._id);
    await course.save();

    res.status(201).json({ chapter });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create chapter.' });
  }
});

// ============================================================================
// LESSON MANAGEMENT
// ============================================================================

// POST /api/cms/courses/:courseId/lessons - Add lesson to a course
router.post('/courses/:courseId/lessons', creatorOnly, async (req, res) => {
  try {
    const {
      title,
      name,
      description,
      objectives,
      newWords,
      reviewWords,
      difficulty,
      estimatedDuration,
      exercises,
    } = req.body;

    const lessonTitle = String(title || name || '').trim();
    if (!lessonTitle) {
      return res.status(400).json({ message: 'Lesson title is required.' });
    }

    if (!isDbConnected()) {
      const course = getFallbackCourseById(req.params.courseId);
      if (!course || String(course.creatorId) !== String(req.user.id)) {
        return res.status(403).json({ message: 'Access denied.' });
      }

      const chapter = ensureFallbackChapter(course);
      const lesson = {
        _id: nextFallbackId('lesson'),
        courseId: course._id,
        chapterId: chapter._id,
        title: lessonTitle,
        description,
        objectives: Array.isArray(objectives) ? objectives : [],
        newWords: Array.isArray(newWords) ? newWords : [],
        reviewWords: Array.isArray(reviewWords) ? reviewWords : [],
        difficulty: difficulty || 2,
        estimatedDuration,
        exercises: Array.isArray(exercises) ? exercises : [],
        order: chapter.lessons.length,
        isPublished: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      getFallbackState().lessons.push(lesson);
      chapter.lessons.push(lesson._id);
      return res.status(201).json({ lesson: buildFallbackLessonPayload(lesson) });
    }

    const course = await Course.findById(req.params.courseId);
    if (!course || String(course.creatorId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    let chapter = await Chapter.findOne({ courseId: course._id, title: 'Default Chapter' });
    if (!chapter) {
      chapter = new Chapter({
        courseId: course._id,
        title: 'Default Chapter',
        description: 'Starter chapter created automatically.',
        order: course.chapters.length,
        lessons: [],
      });
      await chapter.save();
      course.chapters.push(chapter._id);
      await course.save();
    }

    const lesson = new Lesson({
      courseId: course._id,
      chapterId: chapter._id,
      title: lessonTitle,
      description,
      objectives,
      newWords,
      reviewWords,
      difficulty,
      estimatedDuration,
      exercises: Array.isArray(exercises) ? exercises : [],
      order: chapter.lessons.length,
    });

    await lesson.save();

    chapter.lessons.push(lesson._id);
    await chapter.save();

    res.status(201).json({ lesson });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create lesson.' });
  }
});

// GET /api/cms/lessons/:lessonId - Get lesson details
router.get('/lessons/:lessonId', async (req, res) => {
  try {
    if (!isDbConnected()) {
      const lesson = getFallbackLessonById(req.params.lessonId);
      if (!lesson) {
        return res.status(404).json({ message: 'Lesson not found.' });
      }

      const course = getFallbackCourseById(lesson.courseId);
      if (!course) {
        return res.status(404).json({ message: 'Course not found.' });
      }

      const isCreator = String(course.creatorId) === String(req.user.id);
      const isEnrolled = Array.isArray(course.enrolledStudents)
        ? course.enrolledStudents.some((studentId) => String(studentId) === String(req.user.id))
        : false;

      if (!isCreator && !isEnrolled && !course.isPublished) {
        return res.status(403).json({ message: 'Access denied.' });
      }

      return res.json(buildFallbackLessonPayload({ ...lesson, chapterTitle: getFallbackChapterById(lesson.chapterId)?.title || 'Chapter' }));
    }

    const lesson = await Lesson.findById(req.params.lessonId).populate('chapterId');
    if (!lesson) {
      return res.status(404).json({ message: 'Lesson not found.' });
    }

    const course = await Course.findById(lesson.courseId).select('creatorId enrolledStudents isPublished');
    if (!course) {
      return res.status(404).json({ message: 'Course not found.' });
    }

    const isCreator = String(course.creatorId) === String(req.user.id);
    const isEnrolled = Array.isArray(course.enrolledStudents)
      ? course.enrolledStudents.some((studentId) => String(studentId) === String(req.user.id))
      : false;

    if (!isCreator && !isEnrolled && !course.isPublished) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    res.json({
      ...lesson.toObject(),
      chapterTitle: lesson.chapterId?.title || 'Chapter',
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch lesson.' });
  }
});

// POST /api/cms/chapters/:chapterId/lessons - Add lesson
router.post('/chapters/:chapterId/lessons', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const {
      title,
      description,
      objectives,
      newWords,
      reviewWords,
      difficulty,
      estimatedDuration,
      exercises,
    } = req.body;

    const chapter = await Chapter.findById(req.params.chapterId).populate('courseId');
    if (!chapter || chapter.courseId.creatorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const lesson = new Lesson({
      courseId: chapter.courseId._id,
      chapterId: req.params.chapterId,
      title,
      description,
      objectives,
      newWords,
      reviewWords,
      difficulty,
      estimatedDuration,
      exercises,
      order: chapter.lessons.length,
    });

    await lesson.save();

    // Add to chapter
    chapter.lessons.push(lesson._id);
    await chapter.save();

    res.status(201).json({ lesson });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create lesson.' });
  }
});

// ============================================================================
// EXERCISE MANAGEMENT & TTS GENERATION
// ============================================================================

// POST /api/cms/lessons/:lessonId/exercises - Add exercise
router.post('/lessons/:lessonId/exercises', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      const lesson = getFallbackLessonById(req.params.lessonId);
      if (!lesson) {
        return res.status(404).json({ message: 'Lesson not found.' });
      }
      const exercise = req.body;
      if (!Array.isArray(lesson.exercises)) {
        lesson.exercises = [];
      }
      lesson.exercises.push(exercise);
      lesson.updatedAt = new Date().toISOString();
      return res.status(201).json({ exercise: lesson.exercises[lesson.exercises.length - 1] });
    }

    const lesson = await Lesson.findById(req.params.lessonId);
    if (!lesson) {
      return res.status(404).json({ message: 'Lesson not found.' });
    }

    const exercise = req.body;
    lesson.exercises.push(exercise);
    await lesson.save();

    res.status(201).json({ exercise: lesson.exercises[lesson.exercises.length - 1] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create exercise.' });
  }
});

// POST /api/cms/exercises/:id/generate-tts - Auto-generate TTS
router.post('/exercises/:id/generate-tts', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const { language = 'en', voice } = req.body;

    const lesson = await Lesson.findOne({ 'exercises._id': req.params.id });
    if (!lesson) {
      return res.status(404).json({ message: 'Exercise not found.' });
    }

    const exercise = lesson.exercises.find((e) => e._id.toString() === req.params.id);
    if (!exercise || !exercise.prompt) {
      return res.status(400).json({ message: 'Exercise has no prompt for TTS.' });
    }

    // Generate TTS
    const audioResult = await audioService.generateTTS(exercise.prompt, language, voice);

    // Save audio asset
    const audioAsset = new AudioAsset({
      type: 'sentence-tts',
      language,
      text: exercise.prompt,
      url: audioResult.url,
      duration: audioResult.duration,
      voice,
      approved: true,
    });

    await audioAsset.save();

    // Update exercise with audio URL
    exercise.audioUrl = audioResult.url;
    await lesson.save();

    res.json({ exercise, audioUrl: audioResult.url });
  } catch (err) {
    console.error('TTS generation error:', err);
    res.status(500).json({ message: 'Failed to generate TTS.' });
  }
});

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

// POST /api/cms/lessons/:lessonId/bulk-tts - Generate TTS for all exercises
router.post('/lessons/:lessonId/bulk-tts', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const { language = 'en' } = req.body;

    const lesson = await Lesson.findById(req.params.lessonId);
    if (!lesson) {
      return res.status(404).json({ message: 'Lesson not found.' });
    }

    let generatedCount = 0;
    const errors = [];

    for (const exercise of lesson.exercises) {
      try {
        if (!exercise.audioUrl && exercise.prompt) {
          const audioResult = await audioService.generateTTS(exercise.prompt, language);
          exercise.audioUrl = audioResult.url;
          generatedCount++;
        }
      } catch (err) {
        errors.push({ exercise: exercise._id, error: err.message });
      }
    }

    await lesson.save();

    res.json({
      message: `Generated TTS for ${generatedCount} exercises`,
      generatedCount,
      errors,
    });
  } catch (err) {
    res.status(500).json({ message: 'Bulk TTS generation failed.' });
  }
});

// POST /api/cms/lessons/:lessonId/publish - Publish lesson
router.post('/lessons/:lessonId/publish', creatorOnly, async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const lesson = await Lesson.findById(req.params.lessonId);
    if (!lesson) {
      return res.status(404).json({ message: 'Lesson not found.' });
    }

    // Validation
    if (lesson.exercises.length === 0) {
      return res.status(400).json({ message: 'Lesson must have at least one exercise.' });
    }

    lesson.isPublished = true;
    lesson.approvedBy = req.user.id;
    await lesson.save();

    res.json({ lesson, message: 'Lesson published successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to publish lesson.' });
  }
});

module.exports = router;
